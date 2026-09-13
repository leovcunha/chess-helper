import type { Category, EngineSettings } from '../types';
import { isMateScore, mateDistance } from './engine';
import { PIECE_NAMES, materialDelta, phaseOf, uciToSan } from './position';

/**
 * Themed mistake taxonomy, grounded in how coaches and puzzle sites classify
 * errors (lichess puzzle themes like hangingPiece/backRankMate, and coaching
 * taxonomies: hung piece, missed tactic, positional error, failed conversion).
 * Every mistake maps to exactly one theme; severity lives in the cpl value.
 */
export const CATEGORY_META: Record<Category, { label: string; icon: string; color: string; description: string }> = {
  'allowed-mate': {
    label: 'Allowed forced mate',
    icon: '☠️',
    color: '#e5484d',
    description: 'After your move the opponent has a forced checkmate.',
  },
  'missed-mate': {
    label: 'Missed forced mate',
    icon: '🏆',
    color: '#f76b15',
    description: 'You had a forced checkmate here and played something else.',
  },
  'back-rank': {
    label: 'Back-rank slip',
    icon: '🛡️',
    color: '#d6409f',
    description: 'A mate (or mating attack) on the home rank — the king trapped by its own pawns.',
  },
  'hung-piece': {
    label: 'Hung a piece',
    icon: '♟️',
    color: '#e54666',
    description: 'Your move lets the opponent capture material for free.',
  },
  'missed-tactic': {
    label: 'Missed a tactic',
    icon: '💎',
    color: '#ffb224',
    description: 'The engine line wins material here (capture, fork, promotion) — your move does not.',
  },
  'lost-win': {
    label: 'Lost a winning position',
    icon: '📉',
    color: '#8e6ee6',
    description: 'The position was clearly winning and this move let the advantage slip away.',
  },
  positional: {
    label: 'Positional error',
    icon: '🧭',
    color: '#8e9bb3',
    description: 'The eval dropped without a material swing — a weakening move or misplaced piece.',
  },
};

// display order on the map (training queue sorts by frequency, not this)
export const CATEGORY_ORDER: Category[] = [
  'allowed-mate',
  'missed-mate',
  'back-rank',
  'hung-piece',
  'missed-tactic',
  'lost-win',
  'positional',
];

export interface ClassifyInput {
  fenBefore: string;
  fenAfter: string;
  ply: number;
  evalBefore: number; // mover's perspective, cp/mate-encoded, at position before move
  evalAfterPlayer: number; // mover's eval after their move (given opponent's best reply)
  playedUci: string;
  bestUci: string; // engine best at fenBefore
  bestPvReply?: string; // opponent's reply along the BEST line (pv move 2), when stored
  opponentBestUci: string; // engine best reply at fenAfter (from that position's analysis)
  minCpl: number;
}

export interface ClassifyResult {
  category?: Category;
  phase: ReturnType<typeof phaseOf>;
  hungPiece?: string;
  reason?: string; // human-readable evidence for the label
  confidence?: 'high' | 'medium' | 'low';
}

const WINNING_CP = 250; // "clearly winning" threshold for the lost-win theme
const BACK_RANK_MAJOR = new Set(['r', 'q']);

/**
 * Classify a move given engine evals before/after. `evalBefore`/`evalAfterPlayer`
 * are from the mover's perspective (cp where mate is encoded as ±(MATE_BASE - n)).
 */
export function classifyMove(input: ClassifyInput): ClassifyResult {
  const { evalBefore, evalAfterPlayer, playedUci, bestUci, bestPvReply, opponentBestUci, fenBefore, fenAfter, ply, minCpl } = input;
  const cpl = Math.max(0, evalBefore - evalAfterPlayer);
  const phase = phaseOf(fenBefore, ply);
  const out: ClassifyResult = { phase };
  const oppSan = uciToSan(fenAfter, opponentBestUci);
  const bestSan = uciToSan(fenBefore, bestUci);

  if (cpl < minCpl) return out;

  // In dead-lost positions small drops are noise — don't map them.
  if (evalBefore <= -950 && !isMateScore(evalBefore) && cpl < 500) return out;

  // 1. Had a forced mate and didn't play it
  const hadMate = isMateScore(evalBefore) && evalBefore > 0;
  const stillMate = isMateScore(evalAfterPlayer) && evalAfterPlayer > 0;
  if (hadMate && !stillMate) {
    const backRank = isBackRankPattern(fenBefore, bestUci);
    out.category = backRank ? 'back-rank' : 'missed-mate';
    out.confidence = 'high';
    out.reason = `You had a forced mate here (best: ${bestSan}${backRank ? ', on the back rank' : ''}).`;
    return out;
  }

  // 2. Allowed the opponent a forced mate (that wasn't already there)
  const allowedMateNow = isMateScore(evalAfterPlayer) && evalAfterPlayer < 0;
  const mateWasThere = isMateScore(evalBefore) && evalBefore < 0;
  if (allowedMateNow && !mateWasThere) {
    const backRank = isBackRankPattern(fenAfter, opponentBestUci);
    out.category = backRank ? 'back-rank' : 'allowed-mate';
    out.confidence = 'high';
    out.hungPiece = `mate in ${mateDistance(evalAfterPlayer)}`;
    out.reason = `After your move the opponent plays ${oppSan} and forces mate in ${mateDistance(evalAfterPlayer)}.`;
    return out;
  }

  // 3. Hung a piece: after our move, the opponent's best reply captures material.
  //    Compare BOTH sides of the exchange — what our move captured (myGain) minus
  //    what their recapture takes back (hungDelta). A clean even trade nets 0 and
  //    must not be flagged; only losing the net exchange counts.
  //    materialDelta is measured for the side to move at the given position.
  const myGain = materialDelta(fenBefore, [playedUci]);
  const hungDelta = materialDelta(fenAfter, [opponentBestUci]);
  const netLoss = hungDelta - myGain;
  if (netLoss >= 100) {
    out.category = 'hung-piece';
    out.hungPiece = hungPieceName(fenAfter, opponentBestUci);
    out.confidence = netLoss >= 250 ? 'high' : 'medium';
    out.reason = `The opponent's best reply (${oppSan}) captures your ${out.hungPiece}; after the exchange you are down ${(netLoss / 100).toFixed(1)} pawns.`;
    return out;
  }

  // 4. Missed a tactic: the best line gains material that our move doesn't.
  //    Both sides are simulated along the BEST line's own pv (our best move +
  //    the opponent's best answer to THAT move), never mixing variations.
  if (cpl >= 150) {
    const bestReply = bestPvReply ?? opponentBestUci;
    const bestDelta = materialDelta(fenBefore, [bestUci, bestReply]);
    const playedDelta = materialDelta(fenBefore, [playedUci, opponentBestUci]);
    if (bestDelta - playedDelta >= 150) {
      const gained = (bestDelta - playedDelta) / 100;
      out.category = 'missed-tactic';
      out.confidence = bestDelta - playedDelta >= 300 ? 'high' : 'medium';
      out.reason = `${bestSan} was winning ~${gained.toFixed(1)} pawns of material; your move doesn't.`;
      return out;
    }
  }

  // 5. Conversion failure: clearly winning, let it slip.
  if (evalBefore >= WINNING_CP && evalAfterPlayer <= 120) {
    out.category = 'lost-win';
    out.confidence = 'medium';
    out.reason = `You were +${(evalBefore / 100).toFixed(1)} here; after your move it's +${(Math.max(0, evalAfterPlayer) / 100).toFixed(1)}.`;
    return out;
  }

  // 6. Everything else: an eval drop with no material swing.
  out.category = 'positional';
  out.confidence = 'low';
  out.reason = `The engine sees a ${(cpl / 100).toFixed(1)}-pawn drop with no material change — could be a real positional loss or eval noise at this depth.`;
  return out;
}

/** True if `uci` is a major piece landing on the mover's home rank (back-rank pattern). */
function isBackRankPattern(fen: string, uci: string): boolean {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const toRank = to[1];
  const piece = pieceTypeAt(fen, from);
  if (!piece || !BACK_RANK_MAJOR.has(piece)) return false;
  // the mover is the side to move in `fen`; their home rank is 1 for white, 8 for black
  const moverIsWhite = fen.split(' ')[1] === 'w';
  return toRank === (moverIsWhite ? '8' : '1');
}

function pieceTypeAt(fen: string, square: string): string | undefined {
  const board = fen.split(' ')[0] ?? '';
  const files = 'abcdefgh';
  let file = 0;
  let rank = 8;
  for (const ch of board) {
    if (ch === '/') {
      rank--;
      file = 0;
      continue;
    }
    if (/\d/.test(ch)) {
      file += parseInt(ch, 10);
      continue;
    }
    if (files[file] + rank === square) return ch.toLowerCase();
    file++;
  }
  return undefined;
}

function hungPieceName(fenAfter: string, opponentBestUci: string): string {
  const from = opponentBestUci.slice(2, 4);
  const board = fenAfter.split(' ')[0] ?? '';
  const files = 'abcdefgh';
  // walk the board tracking file+rank to find the piece on the capture target square
  let file = 0;
  let rank = 8;
  let captured: string | undefined;
  for (const ch of board) {
    if (ch === '/') {
      rank--;
      file = 0;
      continue;
    }
    if (/\d/.test(ch)) {
      file += parseInt(ch, 10);
      continue;
    }
    const sq = files[file] + rank;
    if (sq === from) {
      captured = ch.toLowerCase();
      break;
    }
    file++;
  }
  if (captured && PIECE_NAMES[captured]) return PIECE_NAMES[captured];
  // en-passant or unknown: fall back to a pawn (the only ep capture)
  return 'pawn';
}

/* ---------------- accuracy (lichess-style win% model) ---------------- */

function winPercent(cpWhite: number): number {
  const clamped = Math.max(-1500, Math.min(1500, cpWhite));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}

/** Accuracy of one move, given mover-relative evals before/after and the mover's color. */
export function moveAccuracy(evalBefore: number, evalAfter: number, color: 'w' | 'b'): number {
  const sign = color === 'w' ? 1 : -1;
  const before = isMateScore(evalBefore) ? sign * (evalBefore > 0 ? 1500 : -1500) : sign * evalBefore;
  const after = isMateScore(evalAfter) ? sign * (evalAfter > 0 ? 1500 : -1500) : sign * evalAfter;
  const wpBefore = winPercent(before);
  const wpAfter = winPercent(after);
  // evals are now white-centric; the MOVER loses accuracy when THEIR win%
  // drops — for Black that is the opposite direction of the white-centric delta
  const rawDrop = color === 'w' ? wpBefore - wpAfter : wpAfter - wpBefore;
  const drop = Math.max(0, rawDrop);
  const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

/* ---------------- schema migration ---------------- */

export const ANALYSIS_SCHEMA = 6;

/**
 * Re-run the themed classifier over an existing analysis without touching the
 * engine — all inputs (evals, pv lines) are already stored per ply. Used to
 * migrate analyses created with an older taxonomy.
 */
export function reclassifyAnalysis(
  a: import('../types').GameAnalysis,
  minCpl: number
): import('../types').GameAnalysis {
  const reclassified = a.plies.map((p, i) => {
    // only the player's own moves are classified (odd ply = white's move)
    const isPlayerMove = (p.ply % 2 === 1) === (a.playerColor === 'w');
    if (!isPlayerMove || p.cpl < minCpl) {
      return { ...p, category: undefined, phase: p.phase ?? phaseOf(p.fenBefore, p.ply), hungPiece: undefined, reason: undefined, confidence: undefined };
    }
    const cls = classifyMove({
      fenBefore: p.fenBefore,
      fenAfter: p.fenAfter,
      ply: p.ply,
      evalBefore: p.evalBefore,
      evalAfterPlayer: p.evalAfterPlayer,
      playedUci: p.playedUci,
      bestUci: p.best[0]?.uci ?? p.playedUci,
      bestPvReply: p.best[0]?.pv?.[1],
      opponentBestUci: a.plies[i + 1]?.best[0]?.uci ?? p.playedUci,
      minCpl,
    });
    return { ...p, category: cls.category, phase: cls.phase, hungPiece: cls.hungPiece, reason: cls.reason, confidence: cls.confidence };
  });
  return {
    ...a,
    schema: ANALYSIS_SCHEMA,
    plies: reclassified,
    mistakeCount: reclassified.filter(p => p.category).length,
  };
}
