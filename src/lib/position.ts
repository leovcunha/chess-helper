import { Chess } from 'chess.js';
import type { Color, Phase } from '../types';

export interface PlyInfo {
  ply: number; // 1-based half-move index
  san: string;
  uci: string; // e.g. g1f3 (matches engine UCI)
  color: Color;
  piece: string;
  captured?: string; // piece type that was captured by this move
  fenBefore: string;
  fenAfter: string;
}

function newChess(fen?: string): Chess {
  if (fen) {
    try {
      return new Chess(fen);
    } catch {
      /* fall through to default position */
    }
  }
  return new Chess();
}

/** Rebuild per-ply info (FENs, UCI, captures) from a SAN move list. */
export function replayGame(startFen: string | undefined, sans: string[]): { plies: PlyInfo[]; finalFen: string; error?: string } {
  const chess = newChess(startFen);
  const plies: PlyInfo[] = [];
  let fenBefore = chess.fen();
  for (let i = 0; i < sans.length; i++) {
    let mv;
    try {
      mv = chess.move(sans[i]);
    } catch {
      return { plies, finalFen: fenBefore, error: `illegal move "${sans[i]}" at ply ${i + 1}` };
    }
    const fenAfter = chess.fen();
    plies.push({
      ply: i + 1,
      san: mv.san,
      uci: `${mv.from}${mv.to}${mv.promotion ?? ''}`,
      color: mv.color as Color,
      piece: mv.piece,
      captured: (mv as { captured?: string }).captured,
      fenBefore,
      fenAfter,
    });
    fenBefore = fenAfter;
  }
  return { plies, finalFen: fenBefore };
}

/** Convert a UCI move to SAN in the given position. Returns the raw UCI on failure. */
export function uciToSan(fen: string, uci: string): string {
  try {
    const chess = newChess(fen);
    const mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
    return mv.san;
  } catch {
    return uci;
  }
}

const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const PIECE_NAMES: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

/** Material (pawns=1, knights/bishops=3, rooks=5, queens=9) for [white, black] from a FEN. */
export function materialFromFen(fen: string): [number, number] {
  const board = fen.split(' ')[0] ?? '';
  let w = 0;
  let b = 0;
  for (const ch of board) {
    if (ch === '/') continue;
    const v = PIECE_VALUES[ch.toLowerCase()];
    if (!v) continue;
    if (ch === ch.toUpperCase()) w += v;
    else b += v;
  }
  return [w, b];
}

/** Rough game phase from the position + move number. */
export function phaseOf(fen: string, ply: number): Phase {
  const [w, b] = materialFromFen(fen);
  if (w + b <= 13) return 'endgame';
  if (ply <= 20) return 'opening';
  return 'middlegame';
}

/** Simulate a list of UCI moves from a position, returning player-material delta
 *  for the side to move at `fen` (captures made BY the side to move count +,
 *  captures made AGAINST them count -). */
export function materialDelta(fen: string, uciMoves: string[]): number {
  const chess = newChess(fen);
  const startColor = chess.turn() as Color;
  let delta = 0;
  for (const uci of uciMoves) {
    let mv;
    try {
      mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
    } catch {
      return delta;
    }
    const captured = (mv as { captured?: string }).captured;
    if (captured) {
      const v = PIECE_VALUES[captured] ?? 0;
      if (mv.color === startColor) delta += v;
      else delta -= v;
    }
  }
  return delta * 100; // to centipawns
}
