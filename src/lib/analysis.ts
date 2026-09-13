import type { BestLine, GameAnalysis, GameRecord, PlyAnalysis } from '../types';
import { EnginePool, getEnginePool, isMateScore } from './engine';
import { ANALYSIS_SCHEMA, classifyMove, moveAccuracy } from './classify';
import { parseHeaders, parseMovetext } from './pgn';
import { replayGame, uciToSan } from './position';

export interface AnalysisProgress {
  phase: 'loading-engine' | 'analyzing' | 'done';
  gamesTotal: number;
  gamesDone: number;
  gameLabel: string;
  ply: number; // positions analyzed (global)
  pliesTotal: number; // total positions in the job
}

export function engineKeyOf(engineName: string, depth: number, mpv: number): string {
  return `${engineName}|d${depth}|mpv${mpv}`;
}

export interface AnalyzeOptions {
  games: GameRecord[];
  depth: number;
  mpv: number;
  minCpl: number;
  onProgress: (p: AnalysisProgress) => void;
  shouldCancel: () => boolean;
  onGameAnalyzed: (a: GameAnalysis) => Promise<void> | void;
}

export interface AnalysisFailure {
  game: string;
  reason: string;
}

export interface AnalysisResult {
  analyzed: number;
  partial: number;
  failed: number;
  cancelled: boolean;
  failures: AnalysisFailure[];
}

interface ParsedGame {
  game: GameRecord;
  plies: ReturnType<typeof replayGame>['plies'];
  fens: string[];
}

interface Task {
  gameIdx: number;
  fenIdx: number;
}

/**
 * Analyze games with a bounded, abortable work queue: exactly `poolSize`
 * searches are ever in flight, so Cancel takes effect immediately and memory
 * stays flat no matter how many games were imported. Each failed search is
 * retried once; positions that still fail are marked on the game (partial)
 * instead of silently counting as perfect moves.
 */
export async function analyzeGames(opts: AnalyzeOptions, poolOverride?: EnginePool): Promise<AnalysisResult> {
  const pool = poolOverride ?? (await getEnginePool());
  const engineKey = engineKeyOf(pool.name.split(' ×')[0], opts.depth, opts.mpv);
  const failures: AnalysisFailure[] = [];
  let cancelled = false;

  opts.onProgress({ phase: 'loading-engine', gamesTotal: opts.games.length, gamesDone: 0, gameLabel: pool.name, ply: 0, pliesTotal: 0 });

  // parse everything up front; invalid PGNs become failures without blocking the queue
  const parsed: (ParsedGame | null)[] = opts.games.map(game => {
    try {
      const headers = parseHeaders(game.pgn);
      const sans = parseMovetext(game.pgn);
      const { plies, finalFen, error } = replayGame(headers['FEN'], sans);
      if (error || plies.length === 0) throw new Error(error ?? 'no moves found in PGN');
      const fens = plies.map(p => p.fenBefore);
      fens.push(finalFen);
      return { game, plies, fens };
    } catch (e) {
      failures.push({ game: gameLabel(game), reason: e instanceof Error ? e.message : String(e) });
      return null;
    }
  });

  const tasksTotal = parsed.reduce((n, g) => n + (g ? g.fens.length : 0), 0);
  const results: (PositionEval | null)[][] = parsed.map(g => (g ? new Array(g.fens.length).fill(null) : []));
  const remaining = parsed.map(g => (g ? g.fens.length : 0));
  const failedEvals = parsed.map(g => (g ? new Set<number>() : new Set<number>()));
  let tasksDone = 0;
  let gamesDone = 0;

  const tasks: Task[] = [];
  parsed.forEach((g, gi) => {
    if (!g) return;
    for (let fi = 0; fi < g.fens.length; fi++) tasks.push({ gameIdx: gi, fenIdx: fi });
  });

  let next = 0;
  const bumpProgress = (label: string) =>
    opts.onProgress({
      phase: 'analyzing',
      gamesTotal: opts.games.length,
      gamesDone,
      gameLabel: label,
      ply: tasksDone,
      pliesTotal: tasksTotal,
    });

  let analyzed = 0;
  let partial = 0;
  const persistedFlag = parsed.map(() => false);
  const persistGame = async (gi: number): Promise<void> => {
    if (persistedFlag[gi]) return;
    persistedFlag[gi] = true;
    const g = parsed[gi]!;
    const analysis = buildAnalysis(g, results[gi], failedEvals[gi], engineKey, opts);
    await opts.onGameAnalyzed(analysis);
    if (analysis.partial) partial++;
    else analyzed++;
    gamesDone++;
    bumpProgress(gameLabel(g.game));
  };

  const runTask = async (t: Task): Promise<void> => {
    const g = parsed[t.gameIdx]!;
    const fen = g.fens[t.fenIdx];
    let r: Awaited<ReturnType<EnginePool['analyze']>> | null = null;
    for (let attempt = 0; attempt < 2 && !r; attempt++) {
      if (opts.shouldCancel()) break;
      try {
        r = await pool.analyze(fen, opts.depth, opts.mpv, 15_000);
      } catch {
        r = null;
        if (attempt === 0) await new Promise(res => setTimeout(res, 200)); // brief pause before the retry
      }
    }
    if (r) {
      results[t.gameIdx][t.fenIdx] = {
        lines: r.lines.map(l => ({ ...l, san: uciToSan(fen, l.uci) })),
        bestCp: r.lines[0].cp,
      };
    } else {
      failedEvals[t.gameIdx].add(t.fenIdx);
    }
    tasksDone++;
    remaining[t.gameIdx]--;
    // a game is saved the moment its last search finishes
    if (remaining[t.gameIdx] === 0 && !opts.shouldCancel()) {
      await persistGame(t.gameIdx);
    }
    bumpProgress(gameLabel(g.game));
  };

  const consumer = async (): Promise<void> => {
    while (!opts.shouldCancel()) {
      const idx = next++;
      if (idx >= tasks.length) return;
      await runTask(tasks[idx]);
    }
    cancelled = true;
  };

  const concurrency = Math.max(1, pool.size ?? 1);
  await Promise.all(Array.from({ length: concurrency }, () => consumer()));

  // safety net: persist anything that completed but slipped past the per-task path
  for (let gi = 0; gi < parsed.length; gi++) {
    const g = parsed[gi];
    if (!g || remaining[gi] > 0 || persistedFlag[gi]) continue; // incomplete (cancelled) → skip
    await persistGame(gi);
  }

  gamesDone = analyzed + partial + failures.length;
  opts.onProgress({ phase: 'done', gamesTotal: opts.games.length, gamesDone, gameLabel: '', ply: tasksDone, pliesTotal: tasksTotal });
  return { analyzed, partial, failed: failures.length, cancelled, failures };
}

function buildAnalysis(
  g: ParsedGame,
  evals: (PositionEval | null)[],
  failedIdx: Set<number>,
  engineKey: string,
  opts: AnalyzeOptions
): GameAnalysis {
  const plyAnalyses: PlyAnalysis[] = [];
  let accSum = 0;
  let accCount = 0;
  let mistakeCount = 0;

  for (let i = 0; i < g.plies.length; i++) {
    const ply = g.plies[i];
    const evalHere = evals[i];
    const evalNext = evals[i + 1];
    const isPlayer = ply.color === g.game.playerColor;
    const evalFailedHere = evalHere === null || failedIdx.has(i) || failedIdx.has(i + 1) || evalNext === null;
    let plyAnalysis: PlyAnalysis;

    if (!evalHere || !evalNext) {
      // failed searches are NOT neutral: mark the ply so it is excluded from
      // accuracy and classification instead of counting as a perfect move
      plyAnalysis = {
        ply: ply.ply,
        fenBefore: ply.fenBefore,
        fenAfter: ply.fenAfter,
        playedSan: ply.san,
        playedUci: ply.uci,
        evalBefore: 0,
        evalAfterPlayer: 0,
        cpl: 0,
        best: [],
        evalFailed: true,
      };
    } else {
      const evalBefore = evalHere.bestCp;
      // after the move (opponent to move): negate their best eval to get ours
      const evalAfterPlayer = -evalNext.bestCp;
      const playedIsBest = evalHere.lines.length > 0 && evalHere.lines[0].uci === ply.uci;
      const cpl = Math.max(0, evalBefore - evalAfterPlayer);
      plyAnalysis = {
        ply: ply.ply,
        fenBefore: ply.fenBefore,
        fenAfter: ply.fenAfter,
        playedSan: ply.san,
        playedUci: ply.uci,
        evalBefore,
        evalAfterPlayer,
        cpl,
        best: evalHere.lines,
      };
      if (isPlayer && !evalFailedHere) {
        accSum += moveAccuracy(evalBefore, evalAfterPlayer, ply.color);
        accCount++;
        if (!playedIsBest && cpl >= opts.minCpl) {
          const cls = classifyMove({
            fenBefore: ply.fenBefore,
            fenAfter: ply.fenAfter,
            ply: ply.ply,
            evalBefore,
            evalAfterPlayer,
            playedUci: ply.uci,
            bestUci: evalHere.lines[0].uci,
            bestPvReply: evalHere.lines[0]?.pv?.[1],
            opponentBestUci: evalNext.lines[0]?.uci ?? ply.uci,
            minCpl: opts.minCpl,
          });
          plyAnalysis.category = cls.category;
          plyAnalysis.phase = cls.phase;
          plyAnalysis.hungPiece = cls.hungPiece;
          if (cls.category) mistakeCount++;
        }
      }
    }
    plyAnalyses.push(plyAnalysis);
  }

  const partial = plyAnalyses.some(p => p.evalFailed);
  return {
    key: `${g.game.key}|${engineKey}`,
    gameKey: g.game.key,
    engineKey,
    schema: ANALYSIS_SCHEMA,
    depth: opts.depth,
    mpv: opts.mpv,
    playerColor: g.game.playerColor,
    accuracy: accCount > 0 ? Math.round((accSum / accCount) * 10) / 10 : 0,
    plies: plyAnalyses,
    mistakeCount,
    partial,
    createdAt: Date.now(),
  };
}

interface PositionEval {
  lines: BestLine[]; // stm-relative, best first
  bestCp: number;
}

export function gameLabel(g: GameRecord): string {
  const opponent = g.playerColor === 'w' ? g.black : g.white;
  const you = g.playerColor === 'w' ? g.white : g.black;
  const site = g.site === 'lichess' ? 'Lichess' : g.site === 'chesscom' ? 'Chess.com' : 'Import';
  return `${you} vs ${opponent} · ${g.timeClass} · ${site}`;
}

export function formatEval(cp: number, colorOfView: 'w' | 'b'): string {
  // eval is stm-relative; convert to white-centric for display
  const whiteCp = colorOfView === 'w' ? cp : -cp;
  if (isMateScore(whiteCp)) {
    return whiteCp > 0 ? `+M${1000000 - whiteCp}` : `-M${1000000 + whiteCp}`;
  }
  return `${whiteCp >= 0 ? '+' : ''}${(whiteCp / 100).toFixed(2)}`;
}
