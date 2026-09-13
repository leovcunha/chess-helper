# Chess Mistake Trainer (Blunderbook)

Import your games from **Lichess** and **Chess.com**, analyze every move locally with **Stockfish 16 (WASM)**,
see a **map of your most common mistakes** (hung pieces, missed mates, missed tactics…), and then **train on the
exact positions where you went wrong** — from most common mistake to least, with instant right/wrong feedback.

Everything runs 100% in your browser. No accounts, no server, no data leaving your machine.

## Features

- **Import** — fetch recent games by username from Lichess and Chess.com (public APIs, CORS-safe), or paste/upload
  any PGN. Filters: time control (bullet/blitz/rapid/classical), rated-only.
- **Analyze** — Stockfish 16 (WASM) evaluates *every position* of every game (MultiPV 3). Analysis runs on a pool of
  parallel engine workers (one per CPU core, up to 4) fed by a bounded queue — Cancel takes effect immediately and
  failed searches are retried once, then marked (games show as *partial* instead of silently counting as perfect).
  Results are cached in IndexedDB, so re-running never repeats work.
- **Train** — a drill queue built from your real mistakes: the board shows the position *before* your mistake,
  you play the better move, and the app tells you immediately whether you got it right (engine-verified, with
  tolerance for equally-good alternatives). Nothing advances until you press Next; you can ↻ Try again, step through
  👁 the best line move by move, or skip. Positions you miss come back later in the session, and your history
  persists: recently-missed positions surface first, mastered ones drop to the back. Sessions survive a page refresh.
- **Mistake Map** — your mistakes aggregated into **themed categories** (inspired by lichess puzzle themes and
  coaching taxonomies) and ranked most-common first:
  - ☠️ **Allowed forced mate** — after your move the opponent has a forced mate
  - 🏆 **Missed forced mate** — you had a forced mate and played something else
  - 🛡️ **Back-rank slip** — a mate/attack on the home rank (king trapped by its own pawns)
  - ♟️ **Hung a piece** — your move lets the opponent capture material for free (map shows which piece: knight ×3, pawn ×7…)
  - 💎 **Missed a tactic** — the engine line wins material (capture, fork, promotion) that your move doesn't
  - 📉 **Lost a winning position** — a clearly winning position (+2.5 or better) let slip
  - 🌫️ **Positional error** — the eval dropped with no material swing (weakening move, misplaced piece)
  - broken down by game phase (opening / middlegame / endgame) and by opening; severity is shown per move as
    centipawn loss
- **Train** — a drill queue built from your real mistakes: the board shows the position *before* your mistake,
  you play the better move, and the app tells you immediately whether you got it right (engine-verified, with
  tolerance for equally-good alternatives). Wrong answers come back a few positions later; a session summary shows
  your score.
- **Game review** — per-game accuracy, eval graph, and a move list where mistakes are color-coded; click any move
  to see the engine's best move (green arrow) vs what you played (red arrow).

## Requirements

- [Node.js](https://nodejs.org) 18+ (developed on Node 22)
- Any modern browser (Chrome, Edge, Firefox, Safari)

Tests: `npm test` (vitest — accuracy symmetry, classification fixtures, PGN parsing, cancellation, IndexedDB).

## How to run

```bash
npm install     # also copies the Stockfish engine files into public/engines
npm run dev     # start the dev server → http://localhost:5173
```

Production build:

```bash
npm run build   # type-checks + bundles into dist/
npm run preview # serve the production build locally
```

The app is a static site — after `npm run build` you can host `dist/` anywhere (GitHub Pages, Netlify, …).

## How to test it yourself (5-minute walkthrough)

1. **Start the app** — `npm run dev`, open <http://localhost:5173>.
2. **Import games**
   - Type your Lichess username (e.g. `DrNykterStein`) and/or your Chess.com username.
   - Pick time controls (default: blitz + rapid) and how many games/months to fetch.
   - Click **Fetch games**. You should see "Fetched N games (M new)."
   - No account or games handy? Click **…or paste PGN** and paste any PGN (Lichess: game → Export → PGN).
3. **Analyze**
   - Pick a preset: **Fast (depth 10)** for the first try — Balanced/Deep are slower but sharper.
   - Click **Analyze N stored games**. The engine badge turns green (*Stockfish 16 (WASM)*), and a progress bar
     tracks games and positions. A blitz game takes roughly 1–4 minutes at depth 10–13.
     You can Cancel at any time — finished games are already saved.
4. **See your patterns** — open **2 · Mistake Map**. You'll see your mistakes ranked most-common first, with
   counts per game phase and an openings table.
5. **Train** — click **Train all mistakes** (or expand a pattern and *Train these N*). For each position:
   - Drag the piece to play the move you *should* have played.
   - ✅/❌ feedback appears instantly, with the engine's best move and what you played last time.
   - Use **💡 Hint arrow** if stuck; **Skip** re-queues the position for later in the session.
6. **Review games** — open **Games** → **Review** to scroll through any analyzed game with the eval graph and
   best-vs-played arrows.

### Quick self-test without any chess account

Paste this PGN (a short game with a classic queen blunder) via **…or paste PGN**, then analyze it with **Fast**:

```pgn
[Event "Test game"]
[Site "https://lichess.org/test1"]
[Date "2026.01.01"]
[White "Tester"]
[Black "Opponent"]
[Result "0-1"]
[TimeControl "300+0"]
[ECO "C20"]
[Opening "King's Pawn Game"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Nxd5 6. Nxf7 Kxf7 7. Qf3+ Ke6 8. Nc3 Nb4 9. a3 Nxc2+ 10. Kd1 Nxa1 11. Nxd5 Kd6 12. d4 c5 13. dxc5+ Kxc5 0-1
```

After analysis you should see at least one mapped mistake (e.g. *Hung material* for 11. Kd1?? letting the knight
escape with the rook fork idea, or the queen blunder at the end), and the training queue will contain those
positions.

## How mistakes are detected

Each position is searched to the configured depth with MultiPV. For every move you played:

- `cpl` = centipawn loss = (best eval before your move) − (your eval after the best reply).
- Any move whose loss reaches the minimum threshold (default 50 cpl) is flagged and given exactly one **theme**:
  mate themes first, then hung piece, missed tactic, lost winning position, and finally positional error as the
  catch-all for eval drops without a material swing.
- Moves played in already dead-lost positions (eval ≤ −9.5) are ignored to avoid noise.
- Accuracy uses a win-percentage model (Lichess-style) per move, averaged per game.
- Analyses are tagged with a schema version; when the taxonomy changes, your stored analyses are re-classified
  locally (no engine re-run) the next time the app loads.

## Training grading

- Your move is compared against the stored engine lines: the top move or anything within 40 cpl of it counts as
  correct. Moves outside the stored lines are evaluated on the spot at depth `settings.depth − 3`.
- Nothing advances until you press **Next**: after each attempt you can **↻ Try again** on the same position, or
  move on. A position you didn't solve on the first try is re-queued a few positions later (light spaced repetition).
- Per-position history (attempts/correct) is stored in IndexedDB.

## Tech notes

- **Stack**: Vite + React 18 + TypeScript, zustand, chess.js, react-chessboard.
- **Engine**: the npm `stockfish` package's builds are copied to `public/engines/` and probed at runtime in
  priority order (SF16 single-thread → SF16 non-SIMD → SF10 wasm → SF10 asm.js), so the app works on any browser,
  including without SIMD. If a build needs SharedArrayBuffer it simply fails the probe and the next one is used.
- **Storage**: games, analyses, and training stats live in IndexedDB; settings in localStorage. Clearing site data
  resets the app.
- **CORS**: Lichess and Chess.com public APIs allow cross-origin requests; if a site is unreachable, the import
  view shows the error — the PGN paste/upload path always works offline.

## License notes

The Stockfish engine files bundled in `public/engines/` are **GPLv3** (see `node_modules/stockfish/license.txt`).
If you distribute this app publicly, your distribution must comply with GPLv3 for those parts. Private/local use
is fine.
