// UCI wrapper around the Stockfish WASM builds in /public/engines.
// The stockfish scripts are designed to be loaded directly as Web Workers and
// driven with UCI strings via postMessage. We probe the manifest in priority
// order and keep the first engine that answers "uciok" — this makes the app
// resilient to builds that need SharedArrayBuffer / SIMD that the current
// browser may not provide.

export const MATE_BASE = 1_000_000;

/** Encode a UCI mate score into the cp scale: mate in n for stm = MATE_BASE - n. */
export function encodeScore(mate: number | null, cp: number | null): number {
  if (mate !== null) return mate > 0 ? MATE_BASE - mate : -(MATE_BASE + mate);
  return cp ?? 0;
}

export function isMateScore(cp: number): boolean {
  return Math.abs(cp) > MATE_BASE - 10_000;
}

export function mateDistance(cp: number): number {
  return MATE_BASE - Math.abs(cp);
}

export interface EngineLine {
  uci: string;
  cp: number; // stm-relative, mate encoded
  pv: string[];
}

export interface AnalyzeResult {
  lines: EngineLine[]; // sorted best first
  best: EngineLine;
}

interface ProbeCandidate {
  file: string;
  kind: string;
  label: string;
}

interface PendingSearch {
  lines: Map<number, { depth: number; cp: number | null; mate: number | null; pv: string[] }>;
  resolve: (r: AnalyzeResult) => void;
  reject: (e: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

function normalizeLine(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (typeof d.line === 'string') return d.line;
    if (typeof d.data === 'string') return d.data;
  }
  return '';
}

export class ChessEngine {
  private worker: Worker | null = null;
  private lineHandler: ((line: string) => void) | null = null;
  private pendingSearch: PendingSearch | null = null;
  // Some engine wrappers keep flushing buffered info lines from the previous
  // search after "bestmove". Everything seen while latched is dropped; the
  // latch is released when the next search starts (and a readyok barrier
  // guarantees the stale flush has fully drained before we send the next "go").
  private staleLatch = false;
  name = 'not loaded';
  ready = false;

  /** Load the best available engine from the manifest. Throws if none work. */
  async load(): Promise<void> {
    if (this.ready) return;
    let candidates: ProbeCandidate[] = [];
    try {
      const base = import.meta.env.BASE_URL ?? '/';
      const res = await fetch(`${base}engines/manifest.json`);
      const json = await res.json();
      candidates = json.engines ?? [];
    } catch {
      /* fall through to defaults */
    }
    if (candidates.length === 0) {
      candidates = [
        { file: 'stockfish-nnue-16-single.js', kind: 'wasm', label: 'Stockfish 16' },
        { file: 'stockfish.js', kind: 'wasm', label: 'Stockfish 10' },
        { file: 'stockfish.asm.js', kind: 'asm', label: 'Stockfish 10 (asm)' },
      ];
    }
    const errors: string[] = [];
    for (const c of candidates) {
      try {
        await this.trySpawn(c);
        this.ready = true;
        this.name = c.label;
        return;
      } catch (e) {
        errors.push(`${c.file}: ${e instanceof Error ? e.message : String(e)}`);
        this.destroy();
      }
    }
    throw new Error(`No engine could be loaded. Tried: ${errors.join('; ')}`);
  }

  private trySpawn(c: ProbeCandidate): Promise<void> {
    const base = import.meta.env.BASE_URL ?? '/';
    return new Promise<void>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(`${base}engines/${c.file}`);
      } catch (e) {
        reject(e);
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        worker.terminate();
        reject(new Error('timeout waiting for uciok'));
      }, 15_000);
      const onerror = () => {
        cleanup();
        worker.terminate();
        reject(new Error('worker error'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener('error', onerror);
      };
      worker.addEventListener('error', onerror);
      worker.onmessage = (ev: MessageEvent) => {
        const line = normalizeLine(ev.data);
        if (line.includes('uciok')) {
          cleanup();
          this.attach(worker, c.label);
          // fixed options; MultiPV is set per-search. Modern builds embed the
          // NNUE net, so no EvalFile is needed.
          worker.postMessage('setoption name Threads value 1');
          worker.postMessage('setoption name Hash value 32');
          worker.postMessage('isready');
          resolve();
        }
      };
      worker.postMessage('uci');
    });
  }

  /** Hand a live (uciok-answered) worker to the instance. */
  private attach(worker: Worker, label: string): void {
    this.worker = worker;
    this.name = label;
    worker.onmessage = (ev: MessageEvent) => {
      const line = normalizeLine(ev.data);
      if (!line) return;
      this.lineHandler?.(line);
    };
  }

  /** Wait for readyok after options have been applied. */
  async waitReady(): Promise<void> {
    if (!this.worker) throw new Error('engine not loaded');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.lineHandler = null;
        reject(new Error('timeout waiting for readyok'));
      }, 10_000);
      this.lineHandler = line => {
        if (line.includes('readyok')) {
          clearTimeout(timer);
          this.lineHandler = null;
          resolve();
        }
      };
    });
  }

  /**
   * Barrier between searches: drain any buffered output and wait for readyok so
   * stale info lines from the previous search can never bleed into the next one.
   */
  private syncBarrier(): Promise<void> {
    this.worker?.postMessage('isready');
    return this.waitReady();
  }

  /**
   * Search a FEN to a fixed depth. Resolves when the engine prints bestmove,
   * or early after `softTimeoutMs` by sending "stop".
   */
  async analyze(fen: string, depth: number, mpv: number, softTimeoutMs?: number): Promise<AnalyzeResult> {
    const worker = this.worker;
    if (!worker) throw new Error('engine not loaded');
    const previous = this.pendingSearch;
    void previous;
    // drain stale output from the previous search first
    await this.syncBarrier();
    return new Promise<AnalyzeResult>((resolve, reject) => {
      const lines = new Map<number, { depth: number; cp: number | null; mate: number | null; pv: string[] }>();
      let maxDepth = 0;
      let softTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;

      this.pendingSearch = {
        lines,
        resolve: r => {
          clearTimeout(softTimer);
          clearTimeout(hardTimer);
          this.pendingSearch = null;
          resolve(r);
        },
        reject: e => {
          clearTimeout(softTimer);
          clearTimeout(hardTimer);
          this.pendingSearch = null;
          reject(e);
        },
      };

      this.lineHandler = line => {
        if (this.staleLatch) return;
        if (line.startsWith('info') && !line.includes('upperbound') && !line.includes('lowerbound')) {
          const depthM = /(?:^|\s)depth (\d+)/.exec(line);
          const mpvM = /(?:^|\s)multipv (\d+)/.exec(line);
          const scoreM = /(?:^|\s)score (cp|mate) (-?\d+)/.exec(line);
          const pvIdx = line.indexOf(' pv ');
          if (!depthM || !scoreM) return;
          const d = parseInt(depthM[1], 10);
          if (pvIdx === -1 && d !== 0) return;
          const k = mpvM ? parseInt(mpvM[1], 10) : 1;
          if (d < maxDepth && (lines.get(k)?.depth ?? 0) >= d) return;
          const mate = scoreM[1] === 'mate' ? parseInt(scoreM[2], 10) : null;
          const cp = scoreM[1] === 'cp' ? parseInt(scoreM[2], 10) : null;
          const pv = pvIdx !== -1 ? line.slice(pvIdx + 4).trim().split(/\s+/).filter(Boolean) : [];
          maxDepth = Math.max(maxDepth, d);
          lines.set(k, { depth: d, cp, mate, pv });
        } else if (line.startsWith('bestmove')) {
          this.staleLatch = true;
          const out: EngineLine[] = [];
          for (const k of [...lines.keys()].sort((a, b) => a - b)) {
            const e = lines.get(k)!;
            if (e.depth !== maxDepth) continue;
            out.push({ uci: e.pv[0] ?? '', cp: encodeScore(e.mate, e.cp), pv: e.pv.slice(0, 10) });
          }
          if (out.length === 0) {
            // fall back to whatever the deepest single line was
            for (const e of lines.values()) {
              out.push({ uci: e.pv[0] ?? '', cp: encodeScore(e.mate, e.cp), pv: e.pv.slice(0, 10) });
              break;
            }
          }
          if (out.length === 0) {
            this.pendingSearch?.reject(new Error('engine returned no pv'));
          } else {
            this.pendingSearch?.resolve({ lines: out, best: out[0] });
          }
        }
      };

      if (softTimeoutMs) {
        softTimer = setTimeout(() => {
          this.worker?.postMessage('stop');
        }, softTimeoutMs);
      }
      hardTimer = setTimeout(() => {
        this.pendingSearch?.reject(new Error('engine search timed out'));
      }, (softTimeoutMs ?? 120_000) + 20_000);

      // latch was armed by the previous bestmove; the readyok barrier above has
      // now drained the stale flush, so search output can be trusted again
      this.staleLatch = false;
      worker.postMessage(`setoption name MultiPV value ${mpv}`);
      worker.postMessage(`position fen ${fen}`);
      worker.postMessage(`go depth ${depth}`);
    });
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.lineHandler = null;
    this.pendingSearch = null;
    this.ready = false;
  }
}

// singleton (single engine)
let enginePromise: Promise<ChessEngine> | null = null;
export function getEngine(): Promise<ChessEngine> {
  if (!enginePromise) {
    const engine = new ChessEngine();
    enginePromise = engine
      .load()
      .then(() => engine.waitReady())
      .then(() => engine)
      .catch(e => {
        enginePromise = null;
        throw e;
      });
  }
  return enginePromise;
}

/**
 * A pool of independent single-threaded engines. Each position search is an
 * independent task, so running N workers multiplies analysis throughput roughly
 * by N (memory permitting). Searches are pulled from a FIFO queue by whichever
 * worker is free.
 */
export class EnginePool {
  private engines: ChessEngine[] = [];
  private free: ChessEngine[] = [];
  private waiters: ((e: ChessEngine) => void)[] = [];
  name = 'not loaded';

  get size(): number {
    return this.engines.length;
  }

  /** Spawn and probe `size` engines; keeps however many load successfully. */
  async load(size: number): Promise<number> {
    const attempts = Array.from({ length: size }, () => new ChessEngine());
    const results = await Promise.allSettled(attempts.map(e => e.load().then(() => e.waitReady()).then(() => e)));
    this.engines = results.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<ChessEngine>).value);
    if (this.engines.length === 0) {
      const firstError = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
      throw new Error(firstError ? `No engine could be loaded: ${firstError.reason}` : 'No engine could be loaded');
    }
    this.free = [...this.engines];
    this.name = this.engines[0].name;
    return this.engines.length;
  }

  private acquire(): Promise<ChessEngine> {
    const e = this.free.pop();
    if (e) return Promise.resolve(e);
    return new Promise(resolve => this.waiters.push(resolve));
  }

  private release(e: ChessEngine): void {
    const w = this.waiters.shift();
    if (w) w(e);
    else this.free.push(e);
  }

  async analyze(fen: string, depth: number, mpv: number, softTimeoutMs?: number): Promise<AnalyzeResult> {
    const engine = await this.acquire();
    try {
      return await engine.analyze(fen, depth, mpv, softTimeoutMs);
    } finally {
      this.release(engine);
    }
  }

  destroy(): void {
    for (const e of this.engines) e.destroy();
    this.engines = [];
    this.free = [];
    this.waiters = [];
  }
}

let poolPromise: Promise<EnginePool> | null = null;

/** Worker count: leave one core for the UI, capped for memory sanity. */
export function poolSize(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(4, cores - 1));
}

export function getEnginePool(): Promise<EnginePool> {
  if (!poolPromise) {
    const pool = new EnginePool();
    poolPromise = pool
      .load(poolSize())
      .then(count => {
        pool.name = `${pool.name} ×${count}`;
        return pool;
      })
      .catch(e => {
        poolPromise = null;
        throw e;
      });
  }
  return poolPromise;
}
