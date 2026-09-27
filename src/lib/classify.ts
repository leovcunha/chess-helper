import type { Category, EngineSettings, Site, TimeClass } from '../types';
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
const MIN_ERROR_CPL = 100; // hard floor: drops under 1.0 pawn are imprecisions, never errors/blunders
const MIN_POSITIONAL_CPL = 150; // pure positional errors (no material swing) require >= 1.5 pawns drop
const MIN_WIN_PERCENT_DROP = 8; // minimum win-probability loss (%) to count as a real error
const BACK_RANK_MAJOR = new Set(['r', 'q']);

/**
 * Classify a move given engine evals before/after. `evalBefore`/`evalAfterPlayer`
 * are from the mover's perspective (cp where mate is encoded as ±(MATE_BASE - n)).
 * Imprecisions / minor engine disagreements are excluded — only genuine errors and blunders are mapped.
 */
export function classifyMove(input: ClassifyInput): ClassifyResult {
  const { evalBefore, evalAfterPlayer, playedUci, bestUci, bestPvReply, opponentBestUci, fenBefore, fenAfter, ply, minCpl } = input;
  const cpl = Math.max(0, evalBefore - evalAfterPlayer);
  const phase = phaseOf(fenBefore, ply);
  const out: ClassifyResult = { phase };
  const oppSan = uciToSan(fenAfter, opponentBestUci);
  const bestSan = uciToSan(fenBefore, bestUci);

  const effectiveMinCpl = Math.max(MIN_ERROR_CPL, minCpl);
  if (cpl < effectiveMinCpl) return out;

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

  // Filter out imprecisions where win probability barely changes (e.g. +6.0 -> +4.2 when already winning)
  const wpDrop = winPercent(evalBefore) - winPercent(evalAfterPlayer);
  if (wpDrop < MIN_WIN_PERCENT_DROP) return out;

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

  // 6. Positional error: only flag genuine errors/blunders (>= 1.5 pawns drop), never minor imprecisions.
  if (cpl < MIN_POSITIONAL_CPL) return out;

  out.category = 'positional';
  out.confidence = cpl >= 250 ? 'high' : 'medium';
  out.reason = `The engine sees a ${(cpl / 100).toFixed(1)}-pawn positional drop without immediate material loss.`;
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

/* ---------------- accuracy (official lichess win% & harmonic model) ---------------- */

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

export interface PlayerMoveEval {
  evalBefore: number;
  evalAfterPlayer: number;
  color: 'w' | 'b';
}

function standardDeviation(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Computes official Lichess-style game accuracy from player moves.
 * Combines a volatility-weighted mean and a harmonic mean of move accuracies.
 * The harmonic mean ensures major blunders and mistakes cannot be masked by routine moves.
 */
export function calculateGameAccuracy(moves: PlayerMoveEval[]): number {
  if (moves.length === 0) return 0;

  // 1. Calculate per-move accuracies and win% from player perspective
  const accuracies: number[] = [];
  const winPercents: number[] = [];

  for (const m of moves) {
    const acc = moveAccuracy(m.evalBefore, m.evalAfterPlayer, m.color);
    accuracies.push(acc);

    const sign = m.color === 'w' ? 1 : -1;
    const beforeWhite = isMateScore(m.evalBefore) ? sign * (m.evalBefore > 0 ? 1500 : -1500) : sign * m.evalBefore;
    const wp = winPercent(beforeWhite);
    winPercents.push(m.color === 'w' ? wp : 100 - wp);
  }

  // 2. Volatility weights via sliding window standard deviation (clamped to [0.5, 12])
  const windowSize = Math.max(2, Math.min(8, Math.floor(winPercents.length / 10)));
  const weights: number[] = [];

  for (let i = 0; i < winPercents.length; i++) {
    const start = Math.max(0, i - Math.floor(windowSize / 2));
    const end = Math.min(winPercents.length, start + windowSize);
    const windowVals = winPercents.slice(start, end);
    const sd = standardDeviation(windowVals);
    weights.push(Math.max(0.5, Math.min(12, sd)));
  }

  // 3. Volatility-weighted mean
  let weightSum = 0;
  let weightedAccSum = 0;
  for (let i = 0; i < accuracies.length; i++) {
    const w = weights[i];
    weightSum += w;
    weightedAccSum += w * accuracies[i];
  }
  const weightedMean = weightSum > 0 ? weightedAccSum / weightSum : 0;

  // 4. Harmonic mean (clamped to at least 1 to avoid division by zero)
  let recipSum = 0;
  for (const acc of accuracies) {
    recipSum += 1 / Math.max(1, acc);
  }
  const harmonicMean = recipSum > 0 ? accuracies.length / recipSum : 0;

  // 5. Final game accuracy: mean of volatility-weighted mean and harmonic mean
  const combined = (weightedMean + harmonicMean) / 2;
  return Math.round(Math.max(0, Math.min(100, combined)) * 10) / 10;
}

/* ---------------- estimated elo model ---------------- */

export interface EstimateEloOptions {
  site?: Site;
  timeClass?: TimeClass;
  playerRating?: number;
  opponentRating?: number;
  moveCount?: number;
  fallbackBaseline?: number;
}

/**
 * Empirical conversion tables between Chess.com and Lichess (ChessGoals datasets).
 */
export const CHESSCOM_TO_LICHESS_RAPID_TABLE: readonly { chesscom: number; lichess: number }[] = [
  { chesscom: 200, lichess: 500 },
  { chesscom: 400, lichess: 720 },
  { chesscom: 500, lichess: 820 },
  { chesscom: 600, lichess: 910 },
  { chesscom: 700, lichess: 1005 },
  { chesscom: 800, lichess: 1095 },
  { chesscom: 900, lichess: 1185 },
  { chesscom: 1000, lichess: 1280 },
  { chesscom: 1100, lichess: 1490 },
  { chesscom: 1200, lichess: 1575 },
  { chesscom: 1400, lichess: 1675 },
  { chesscom: 1600, lichess: 1825 },
  { chesscom: 1800, lichess: 2025 },
  { chesscom: 2000, lichess: 2175 },
  { chesscom: 2200, lichess: 2350 },
  { chesscom: 2500, lichess: 2550 },
  { chesscom: 2800, lichess: 2800 },
];

export const CHESSCOM_TO_LICHESS_BLITZ_TABLE: readonly { chesscom: number; lichess: number }[] = [
  { chesscom: 200, lichess: 550 },
  { chesscom: 400, lichess: 850 },
  { chesscom: 500, lichess: 980 },
  { chesscom: 600, lichess: 1080 },
  { chesscom: 800, lichess: 1220 },
  { chesscom: 1000, lichess: 1420 },
  { chesscom: 1200, lichess: 1530 },
  { chesscom: 1400, lichess: 1680 },
  { chesscom: 1600, lichess: 1840 },
  { chesscom: 1800, lichess: 2030 },
  { chesscom: 2000, lichess: 2220 },
  { chesscom: 2200, lichess: 2380 },
  { chesscom: 2400, lichess: 2500 },
  { chesscom: 2600, lichess: 2650 },
  { chesscom: 2800, lichess: 2800 },
];

export const CHESSCOM_TO_LICHESS_TABLE = CHESSCOM_TO_LICHESS_RAPID_TABLE;

/**
 * Expected move accuracy by rating level for Chess.com Rapid.
 */
export const CHESSCOM_RAPID_ACCURACY_ANCHORS: readonly { rating: number; accuracy: number }[] = [
  { rating: 200, accuracy: 50 },
  { rating: 500, accuracy: 60 },
  { rating: 800, accuracy: 68 },
  { rating: 1000, accuracy: 73 },
  { rating: 1200, accuracy: 77 },
  { rating: 1400, accuracy: 81 },
  { rating: 1600, accuracy: 84 },
  { rating: 1800, accuracy: 87 },
  { rating: 2000, accuracy: 90 },
  { rating: 2200, accuracy: 92 },
  { rating: 2500, accuracy: 95 },
  { rating: 2800, accuracy: 97 },
];

/**
 * Expected move accuracy by rating level for Chess.com Blitz.
 */
export const CHESSCOM_BLITZ_ACCURACY_ANCHORS: readonly { rating: number; accuracy: number }[] = [
  { rating: 200, accuracy: 48 },
  { rating: 500, accuracy: 56 },
  { rating: 800, accuracy: 64 },
  { rating: 1000, accuracy: 69 },
  { rating: 1200, accuracy: 73 },
  { rating: 1400, accuracy: 77 },
  { rating: 1600, accuracy: 81 },
  { rating: 1800, accuracy: 84 },
  { rating: 2000, accuracy: 87 },
  { rating: 2200, accuracy: 90 },
  { rating: 2500, accuracy: 93 },
  { rating: 2800, accuracy: 96 },
];

/**
 * Expected move accuracy by rating level for Lichess Rapid.
 */
export const LICHESS_RAPID_ACCURACY_ANCHORS: readonly { rating: number; accuracy: number }[] = [
  { rating: 500, accuracy: 50 },
  { rating: 820, accuracy: 60 },
  { rating: 1050, accuracy: 67 },
  { rating: 1200, accuracy: 71 },
  { rating: 1400, accuracy: 76 },
  { rating: 1600, accuracy: 80 },
  { rating: 1800, accuracy: 84 },
  { rating: 2000, accuracy: 88 },
  { rating: 2200, accuracy: 91 },
  { rating: 2400, accuracy: 93 },
  { rating: 2600, accuracy: 95 },
  { rating: 2800, accuracy: 97 },
];

/**
 * Expected move accuracy by rating level for Lichess Blitz.
 */
export const LICHESS_BLITZ_ACCURACY_ANCHORS: readonly { rating: number; accuracy: number }[] = [
  { rating: 500, accuracy: 48 },
  { rating: 980, accuracy: 56 },
  { rating: 1200, accuracy: 64 },
  { rating: 1400, accuracy: 69 },
  { rating: 1600, accuracy: 74 },
  { rating: 1800, accuracy: 79 },
  { rating: 2000, accuracy: 83 },
  { rating: 2200, accuracy: 87 },
  { rating: 2400, accuracy: 90 },
  { rating: 2600, accuracy: 93 },
  { rating: 2800, accuracy: 96 },
];

export const CHESSCOM_ACCURACY_ANCHORS = CHESSCOM_RAPID_ACCURACY_ANCHORS;
export const LICHESS_ACCURACY_ANCHORS = LICHESS_RAPID_ACCURACY_ANCHORS;
export const EXPECTED_ACCURACY_BY_RATING = LICHESS_RAPID_ACCURACY_ANCHORS;

function getConversionTable(timeClass?: TimeClass): readonly { chesscom: number; lichess: number }[] {
  return timeClass === 'blitz' || timeClass === 'bullet'
    ? CHESSCOM_TO_LICHESS_BLITZ_TABLE
    : CHESSCOM_TO_LICHESS_RAPID_TABLE;
}

/** Convert Chess.com rating to equivalent Lichess rating */
export function chesscomToLichess(chesscomElo: number, timeClass?: TimeClass): number {
  const table = getConversionTable(timeClass);
  if (chesscomElo <= table[0].chesscom) {
    const p0 = table[0];
    return Math.max(100, Math.round(p0.lichess - (p0.chesscom - chesscomElo) * 1.5));
  }
  const last = table[table.length - 1];
  if (chesscomElo >= last.chesscom) {
    return Math.round(last.lichess + (chesscomElo - last.chesscom));
  }
  for (let i = 0; i < table.length - 1; i++) {
    const p1 = table[i];
    const p2 = table[i + 1];
    if (chesscomElo >= p1.chesscom && chesscomElo <= p2.chesscom) {
      const t = (chesscomElo - p1.chesscom) / (p2.chesscom - p1.chesscom);
      return Math.round(p1.lichess + t * (p2.lichess - p1.lichess));
    }
  }
  return last.lichess;
}

/** Convert Lichess rating to equivalent Chess.com rating */
export function lichessToChesscom(lichessElo: number, timeClass?: TimeClass): number {
  const table = getConversionTable(timeClass);
  if (lichessElo <= table[0].lichess) {
    const p0 = table[0];
    return Math.max(100, Math.round(p0.chesscom - (p0.lichess - lichessElo) * 0.67));
  }
  const last = table[table.length - 1];
  if (lichessElo >= last.lichess) {
    return Math.round(last.chesscom + (lichessElo - last.lichess));
  }
  for (let i = 0; i < table.length - 1; i++) {
    const p1 = table[i];
    const p2 = table[i + 1];
    if (lichessElo >= p1.lichess && lichessElo <= p2.lichess) {
      const t = (lichessElo - p1.lichess) / (p2.lichess - p1.lichess);
      return Math.round(p1.chesscom + t * (p2.chesscom - p1.chesscom));
    }
  }
  return last.chesscom;
}

function getAnchors(site?: Site, timeClass?: TimeClass): readonly { rating: number; accuracy: number }[] {
  const isSpeed = timeClass === 'blitz' || timeClass === 'bullet';
  if (site === 'chesscom') {
    return isSpeed ? CHESSCOM_BLITZ_ACCURACY_ANCHORS : CHESSCOM_RAPID_ACCURACY_ANCHORS;
  }
  return isSpeed ? LICHESS_BLITZ_ACCURACY_ANCHORS : LICHESS_RAPID_ACCURACY_ANCHORS;
}

/**
 * Returns the expected accuracy percentage for a given rating level on a specific platform and time control.
 */
export function expectedAccuracyForRating(rating: number, site?: Site, timeClass?: TimeClass): number {
  const anchors = getAnchors(site, timeClass);
  if (rating <= anchors[0].rating) return anchors[0].accuracy;
  const last = anchors[anchors.length - 1];
  if (rating >= last.rating) return last.accuracy;

  for (let i = 0; i < anchors.length - 1; i++) {
    const p1 = anchors[i];
    const p2 = anchors[i + 1];
    if (rating >= p1.rating && rating <= p2.rating) {
      const t = (rating - p1.rating) / (p2.rating - p1.rating);
      return Math.round((p1.accuracy + t * (p2.accuracy - p1.accuracy)) * 10) / 10;
    }
  }
  return last.accuracy;
}

/**
 * Inverses expected accuracy to estimate an unanchored rating when no match metadata exists.
 */
export function ratingForAccuracy(accuracy: number, site?: Site, timeClass?: TimeClass): number {
  const anchors = getAnchors(site, timeClass);
  if (accuracy <= 0) return 100;
  if (accuracy <= anchors[0].accuracy) {
    return Math.max(100, Math.round(anchors[0].rating * (accuracy / anchors[0].accuracy)));
  }
  const last = anchors[anchors.length - 1];
  if (accuracy >= last.accuracy) {
    return Math.min(2850, Math.round(last.rating + (accuracy - last.accuracy) * 12.5));
  }

  for (let i = 0; i < anchors.length - 1; i++) {
    const p1 = anchors[i];
    const p2 = anchors[i + 1];
    if (accuracy >= p1.accuracy && accuracy <= p2.accuracy) {
      const t = (accuracy - p1.accuracy) / (p2.accuracy - p1.accuracy);
      return Math.round(p1.rating + t * (p2.rating - p1.rating));
    }
  }
  return last.rating;
}

/**
 * Estimate player performance rating (Elo) for a match on its native platform.
 *
 * If match rating metadata is present (playerRating, opponentRating, or fallbackBaseline):
 * - Evaluates performance relative to the expected accuracy for that match strength and time control.
 * - Outperforming expected accuracy raises the estimated rating; underperforming lowers it.
 * - Scales sensitivity by move count to prevent short games from swinging wildly.
 *
 * If no match rating is available, smoothly falls back to the unanchored platform curve.
 */
export function estimateElo(accuracy: number, options?: EstimateEloOptions): number {
  if (accuracy <= 0) return 100;

  const site = options?.site;
  const timeClass = options?.timeClass;
  const base =
    options?.playerRating && options?.opponentRating
      ? (options.playerRating + options.opponentRating) / 2
      : options?.playerRating ?? options?.opponentRating ?? options?.fallbackBaseline;

  if (base !== undefined && base > 0) {
    const expected = expectedAccuracyForRating(base, site, timeClass);
    const delta = accuracy - expected;
    const moves = options?.moveCount ?? 20;
    const weight = Math.min(1, Math.max(0.4, moves / 15));
    const perfRating = base + delta * 25 * weight;
    return Math.max(100, Math.min(3200, Math.round(perfRating)));
  }

  return ratingForAccuracy(accuracy, site, timeClass);
}

/* ---------------- schema migration ---------------- */

export const ANALYSIS_SCHEMA = 7;

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
