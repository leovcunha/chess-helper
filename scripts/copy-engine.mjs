// Copies Stockfish builds from node_modules into public/engines and writes a
// manifest.json that the app probes at runtime (first engine to answer
// "uciok" wins). Keeps the app self-contained and offline-capable.
import { existsSync, mkdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const outDir = join(process.cwd(), 'public', 'engines');
mkdirSync(outDir, { recursive: true });

const manifest = { engines: [], net: null };
function pick(baseDir, js, wasm, kind, label) {
  const jsPath = join(baseDir, js);
  if (!existsSync(jsPath)) return false;
  copyFileSync(jsPath, join(outDir, js));
  manifest.engines.push({ file: js, kind, label });
  console.log(`[copy-engine] ${kind}: ${js} (${(statSync(jsPath).size / 1e6).toFixed(1)} MB)`);
  if (wasm) {
    const wasmPath = join(baseDir, wasm);
    if (!existsSync(wasmPath)) throw new Error(`missing ${wasmPath}`);
    copyFileSync(wasmPath, join(outDir, wasm));
  }
  return true;
}

const sf18 = 'node_modules/stockfish/bin';
const sf10 = 'node_modules/stockfish-legacy/src';

// Priority: Stockfish 18 single-threaded full NNUE (net embedded in the wasm,
// no SharedArrayBuffer needed), then the lite net variant for memory-tight
// machines, then the ancient SF10 builds as a safety net.
pick(sf18, 'stockfish-18-single.js', 'stockfish-18-single.wasm', 'wasm', 'Stockfish 18 (WASM)');
pick(sf18, 'stockfish-18-lite-single.js', 'stockfish-18-lite-single.wasm', 'wasm', 'Stockfish 18 lite (WASM)');
pick(sf10, 'stockfish.js', 'stockfish.wasm', 'wasm', 'Stockfish 10 (WASM)');
pick(sf10, 'stockfish.asm.js', null, 'asm', 'Stockfish 10 (asm.js fallback)');

if (manifest.engines.length === 0) {
  console.warn('[copy-engine] No stockfish builds found — engine analysis will be unavailable.');
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`[copy-engine] Wrote public/engines/manifest.json with ${manifest.engines.length} engine(s).`);
