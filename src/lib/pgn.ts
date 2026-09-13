import type { Color, GameRecord, Site, TimeClass } from '../types';

export interface ParsedPgn {
  headers: Record<string, string>;
  sans: string[];
}

/** Split a concatenated PGN stream into individual game strings. */
export function splitPgn(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const parts = normalized.split(/(?=\n\[Event )/g).map(s => s.trim());
  return parts.filter(p => p.length > 0 && p.startsWith('[Event '));
}

/** Parse PGN headers without relying on chess.js API drift. */
export function parseHeaders(pgn: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const re = /^\s*\[(\w+)\s+"([^"]*)"\]\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pgn)) !== null) {
    headers[m[1]] = m[2];
  }
  return headers;
}

/**
 * Extract the SAN move list from PGN movetext. Strips comments {...},
 * recursive variations (...), NAGs ($n), move numbers and results.
 */
export function parseMovetext(pgn: string): string[] {
  // remove headers
  let mt = pgn.replace(/^\s*\[[^\]]*\]\s*$/gm, ' ');
  // remove comments (non-greedy, no nesting in comments)
  mt = mt.replace(/\{[^}]*\}/g, ' ');
  // remove recursive variations (handles one level of nesting)
  for (let i = 0; i < 5; i++) mt = mt.replace(/\([^()]*\)/g, ' ');
  // remove NAGs and results and move numbers
  mt = mt.replace(/\$\d+/g, ' ');
  mt = mt.replace(/\b(1-0|0-1|1\/2-1\/2)\b/g, ' ');
  mt = mt.replace(/\*/g, ' ');
  mt = mt.replace(/\b\d+\.(\.\.)?/g, ' ');
  const sans = mt.split(/\s+/).filter(Boolean);
  return sans;
}

const RESULT_TO_COLOR: Record<string, { w: 'win' | 'loss' | 'draw'; b: 'win' | 'loss' | 'draw' }> = {
  '1-0': { w: 'win', b: 'loss' },
  '0-1': { w: 'loss', b: 'win' },
  '1/2-1/2': { w: 'draw', b: 'draw' },
};

/** Base time in seconds from a TimeControl header like "300+2", "600", "-", "?" */
export function baseTimeSeconds(tc: string): number | null {
  if (!tc || tc === '-' || tc === '?' || tc === 'unlimited') return null;
  const m = /^(\d+)/.exec(tc);
  if (!m) return null;
  return parseInt(m[1], 10);
}

export function timeClassFromSeconds(secs: number | null): TimeClass {
  if (secs === null) return 'rapid';
  if (secs < 180) return 'bullet';
  if (secs <= 480) return 'blitz';
  if (secs <= 1500) return 'rapid';
  return 'classical';
}

function resultFor(headers: Record<string, string>, color: Color): 'win' | 'loss' | 'draw' {
  const res = headers['Result'] ?? '*';
  const map = RESULT_TO_COLOR[res];
  if (!map) return 'draw';
  return map[color];
}

export interface BuildGameArgs {
  site: Site;
  id: string;
  url: string;
  pgn: string;
  username: string;
  timeClassOverride?: TimeClass;
  ratedOverride?: boolean;
  playedAt?: string;
}

/**
 * Build a GameRecord from a PGN string + known metadata.
 * Throws if the movetext contains no moves.
 */
export function buildGameRecord(args: BuildGameArgs): GameRecord {
  const headers = parseHeaders(args.pgn);
  const sans = parseMovetext(args.pgn);
  if (sans.length === 0) throw new Error('no moves in PGN');

  const white = headers['White'] ?? '?';
  const black = headers['Black'] ?? '?';
  const uname = args.username.toLowerCase();
  let playerColor: Color = 'w';
  if (black.toLowerCase() === uname && white.toLowerCase() !== uname) playerColor = 'b';
  else if (white.toLowerCase() !== uname && black.toLowerCase() !== uname) {
    // unknown username (e.g. imported PGN) — assume White
    playerColor = 'w';
  }

  const secs = baseTimeSeconds(headers['TimeControl'] ?? '');
  const timeClass = args.timeClassOverride ?? timeClassFromSeconds(secs);
  const rated = args.ratedOverride ?? (headers['Rated'] ?? 'Yes').toLowerCase() !== 'no';

  let opening: GameRecord['opening'];
  if (headers['ECO']) {
    opening = { eco: headers['ECO'], name: headers['Opening'] ?? headers['ECO'] };
  }

  return {
    key: `${args.site}:${args.id}`,
    site: args.site,
    id: args.id,
    url: args.url,
    pgn: args.pgn,
    white,
    black,
    playerColor,
    playerResult: resultFor(headers, playerColor),
    timeClass,
    rated,
    playedAt: args.playedAt ?? headers['UTCDate'] ?? headers['Date'],
    opening,
    termination: headers['Termination'],
  };
}
