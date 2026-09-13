export type Site = 'lichess' | 'chesscom' | 'import';
export type Color = 'w' | 'b';
export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'classical';

/**
 * Themed mistake categories (inspired by lichess puzzle themes and common
 * coaching taxonomies — hung pieces, missed tactics, back-rank slips,
 * positional errors, failed conversions). Every mistake gets exactly one
 * theme; severity is expressed separately via centipawn loss.
 */
export type Category =
  | 'allowed-mate' // opponent gains a forced mate
  | 'missed-mate' // you had a forced mate and didn't play it
  | 'back-rank' // allowed or missed a back-rank mate pattern
  | 'hung-piece' // opponent's best reply wins material by capture
  | 'missed-tactic' // the engine line wins material that your move doesn't
  | 'lost-win' // clearly winning position let slip
  | 'positional'; // eval drop with no material swing

export type Phase = 'opening' | 'middlegame' | 'endgame';

export interface Opening {
  eco: string;
  name: string;
}

export interface GameRecord {
  key: string; // `${site}:${id}`
  site: Site;
  id: string;
  url: string;
  pgn: string;
  white: string;
  black: string;
  playerColor: Color;
  playerResult: 'win' | 'loss' | 'draw';
  timeClass: TimeClass;
  rated: boolean;
  playedAt?: string;
  opening?: Opening;
  termination?: string;
}

export interface BestLine {
  uci: string; // e.g. "g1f3" (first move of the pv)
  san?: string; // filled in later on the main thread
  cp: number; // from the mover's perspective; mate encoded as ±(MATE_BASE - n)
  pv?: string[];
}

export interface PlyAnalysis {
  ply: number; // 1-based half-move index
  fenBefore: string;
  fenAfter: string;
  playedSan: string;
  playedUci: string;
  evalBefore: number; // stm-relative cp (mate encoded)
  evalAfterPlayer: number; // mover's eval after their move
  cpl: number;
  best: BestLine[]; // engine top lines at the position before the move
  evalFailed?: boolean; // engine search failed — evals are placeholders, never classified
  category?: Category;
  phase?: Phase;
  hungPiece?: string; // e.g. "knight" when category is hung-piece
  reason?: string; // human-readable evidence behind the label
  confidence?: 'high' | 'medium' | 'low'; // how sure the heuristic is
}

export interface GameAnalysis {
  key: string; // `${gameKey}|${engineKey}`
  gameKey: string;
  engineKey: string;
  schema: number; // classification schema version (bumped when taxonomy changes)
  depth: number;
  mpv: number;
  playerColor: Color;
  accuracy: number; // 0-100
  plies: PlyAnalysis[]; // one entry per half-move of the game
  mistakeCount: number;
  partial?: boolean; // true when some positions could not be evaluated
  createdAt: number;
}

export interface TrainingItem {
  posKey: string; // dedupe key: first 4 fen fields
  fen: string; // position before the mistake (player to move)
  category: Category;
  phase: Phase;
  cpl: number;
  best: BestLine[];
  playedSan: string;
  playedUci: string; // uci of the move actually played (shown as the red arrow)
  gameKey: string;
  gameLabel: string;
  gameUrl: string;
  hungPiece?: string;
  reason?: string; // heuristic evidence for the label
  confidence?: 'high' | 'medium' | 'low';
}

export interface TrainingStats {
  attempts: number;
  correct: number;
  lastResult?: 'correct' | 'wrong';
  lastAt?: number;
}

export interface EngineSettings {
  depth: number;
  mpv: number;
  thresholds: { minCpl: number }; // smallest centipawn loss that counts as a mistake
}

export interface ImportFilters {
  lichessUser: string;
  lichessMax: number;
  chesscomUser: string;
  chesscomMonths: number;
  chesscomMax: number; // games to keep from Chess.com (independent of the Lichess cap)
  pgnUsername: string; // who the user is, for PGN imports (color detection)
  timeClasses: TimeClass[];
  ratedOnly: boolean;
}
