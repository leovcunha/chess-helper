import type { GameRecord, ImportFilters, Site, TimeClass } from '../types';
import { buildGameRecord, parseHeaders, splitPgn } from './pgn';

export interface FetchProgress {
  message: string;
  found: number;
}

function pickTimeClass(speed: string): TimeClass | null {
  if (speed === 'bullet' || speed === 'blitz' || speed === 'rapid' || speed === 'classical') return speed;
  return null; // ultraBullet, correspondence, variants…
}

function shouldInclude(g: GameRecord, filters: ImportFilters): boolean {
  if (filters.ratedOnly && !g.rated) return false;
  if (filters.timeClasses.length > 0 && !filters.timeClasses.includes(g.timeClass)) return false;
  return true;
}

/**
 * Only trust game URLs pointing at the real hosts. Substring checks like
 * `siteHeader.includes('lichess.org')` would let attackercrafted URLs such as
 * `https://evil.com/?lichess.org` pass.
 */
export function trustedGameUrl(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'lichess.org' || host.endsWith('.lichess.org')) return url.href;
    if (host === 'chess.com' || host.endsWith('.chess.com')) return url.href;
    return '';
  } catch {
    return '';
  }
}

/** Stable content hash (FNV-1a) so PGN imports keep their identity across sessions. */
export function pgnHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0') + '-' + text.length.toString(36);
}

/** Fetch recent games from Lichess as NDJSON (with embedded PGNs). */
export async function fetchLichess(
  username: string,
  filters: ImportFilters,
  onProgress: (p: FetchProgress) => void
): Promise<GameRecord[]> {
  const params = new URLSearchParams({
    max: String(Math.min(filters.lichessMax * 2, 400)), // over-fetch to survive filtering
    pgnInJson: 'true',
    opening: 'true',
    clocks: 'false',
    evals: 'false',
    literate: 'false',
  });
  if (filters.ratedOnly) params.set('rated', 'true');
  if (filters.timeClasses.length > 0) {
    params.set('perfType', filters.timeClasses.join(','));
  }
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params}`;
  const res = await fetch(url, { headers: { Accept: 'application/x-ndjson' } });
  if (res.status === 404) throw new Error(`Lichess user "${username}" not found`);
  if (!res.ok) throw new Error(`Lichess API error ${res.status}`);
  const text = await res.text();
  const out: GameRecord[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    // variant is a plain string ("standard") in NDJSON responses, but be liberal
    const v = j.variant as string | { key?: string } | undefined;
    const variantKey = typeof v === 'string' ? v : v?.key;
    if (variantKey && variantKey !== 'standard') continue;
    const speed = pickTimeClass((j.speed as string) ?? '');
    if (filters.timeClasses.length > 0 && !speed) continue;
    const players = j.players as { white?: { user?: { name?: string }; rating?: number }; black?: { user?: { name?: string }; rating?: number } } | undefined;
    const white = players?.white?.user?.name ?? '?';
    const black = players?.black?.user?.name ?? '?';
    if (white.toLowerCase() !== username.toLowerCase() && black.toLowerCase() !== username.toLowerCase()) continue;
    const isWhite = white.toLowerCase() === username.toLowerCase();
    const pgn = (j.pgn as string) ?? '';
    if (!pgn) continue;
    try {
      const rec = buildGameRecord({
        site: 'lichess',
        id: j.id as string,
        url: trustedGameUrl(`https://lichess.org/${j.id}`),
        pgn,
        username,
        timeClassOverride: speed ?? undefined,
        ratedOverride: typeof j.rated === 'boolean' ? j.rated : undefined,
        playedAt: j.lastMoveAt ? new Date(j.lastMoveAt as number).toISOString().slice(0, 10) : undefined,
        playerRatingOverride: isWhite ? players?.white?.rating : players?.black?.rating,
        opponentRatingOverride: isWhite ? players?.black?.rating : players?.white?.rating,
      });
      if (!seen.has(rec.key)) {
        seen.add(rec.key);
        out.push(rec);
        onProgress({ message: `Lichess: ${out.length} games`, found: out.length });
      }
    } catch {
      /* unparseable pgn — skip */
    }
  }
  return out.filter(g => shouldInclude(g, filters)).slice(0, filters.lichessMax);
}

/** Fetch recent games from Chess.com monthly archives (JSON, PGN embedded). */
export async function fetchChesscom(
  username: string,
  filters: ImportFilters,
  onProgress: (p: FetchProgress) => void
): Promise<GameRecord[]> {
  const u = encodeURIComponent(username.toLowerCase());
  const archRes = await fetch(`https://api.chess.com/pub/player/${u}/games/archives`);
  if (archRes.status === 404) throw new Error(`Chess.com user "${username}" not found`);
  if (!archRes.ok) throw new Error(`Chess.com API error ${archRes.status}`);
  const archJson = (await archRes.json()) as { archives?: string[] };
  const archives = (archJson.archives ?? []).slice(-filters.chesscomMonths);

  const out: GameRecord[] = [];
  const seen = new Set<string>();
  const cap = Math.max(10, Number.isFinite(filters.chesscomMax) ? filters.chesscomMax : 100); // independent from the Lichess cap
  for (let i = archives.length - 1; i >= 0; i--) {
    if (out.length >= cap) break;
    onProgress({ message: `Chess.com: month ${archives.length - i}/${archives.length} — ${out.length} games`, found: out.length });
    let games: Record<string, unknown>[] = [];
    try {
      const res = await fetch(archives[i]);
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`Chess.com API error ${res.status}`);
      const json = (await res.json()) as { games?: Record<string, unknown>[] };
      games = json.games ?? [];
    } catch (e) {
      if (e instanceof Error && e.message.includes('error')) throw e;
      continue;
    }
    for (const g of games) {
      if (out.length >= cap) break;
      const pgn = g.pgn as string | undefined;
      if (!pgn) continue;
      const timeClass = pickTimeClass(g.time_class as string);
      if (filters.timeClasses.length > 0 && !timeClass) continue;
      const whiteObj = g.white as Record<string, unknown> | undefined;
      const blackObj = g.black as Record<string, unknown> | undefined;
      const white = (whiteObj?.username as string) ?? '?';
      const black = (blackObj?.username as string) ?? '?';
      if (white.toLowerCase() !== username.toLowerCase() && black.toLowerCase() !== username.toLowerCase()) continue;
      const isWhite = white.toLowerCase() === username.toLowerCase();
      const whiteRating = typeof whiteObj?.rating === 'number' ? whiteObj.rating : undefined;
      const blackRating = typeof blackObj?.rating === 'number' ? blackObj.rating : undefined;
      try {
        const url = trustedGameUrl((g.url as string) ?? '');
        const id = url.split('/').filter(Boolean).pop() ?? String(out.length);
        const rec = buildGameRecord({
          site: 'chesscom',
          id,
          url,
          pgn,
          username,
          timeClassOverride: timeClass ?? undefined,
          ratedOverride: typeof g.rated === 'boolean' ? g.rated : undefined,
          playedAt: g.end_time ? new Date((g.end_time as number) * 1000).toISOString().slice(0, 10) : undefined,
          playerRatingOverride: isWhite ? whiteRating : blackRating,
          opponentRatingOverride: isWhite ? blackRating : whiteRating,
        });
        if (!seen.has(rec.key)) {
          seen.add(rec.key);
          out.push(rec);
          onProgress({ message: `Chess.com: ${out.length} games`, found: out.length });
        }
      } catch {
        /* skip */
      }
    }
    await new Promise(r => setTimeout(r, 250)); // be polite to the public API
  }
  return out.filter(g => shouldInclude(g, filters)).slice(0, cap);
}

export interface PgnImportPreview {
  records: GameRecord[]; // valid, deduped within this batch
  duplicatesInBatch: number;
  invalid: number;
}

/**
 * Parse pasted/uploaded PGN for preview. Site/id come from trusted hostnames in
 * the [Site] header; unknown sources get a stable content hash id and site
 * "import". `username` decides which color the user played — always ask for it,
 * otherwise Black players end up training on their opponent's mistakes.
 */
export function parsePgnImports(text: string, username: string, onProgress?: (p: FetchProgress) => void): PgnImportPreview {
  const out: GameRecord[] = [];
  const seen = new Set<string>();
  let duplicatesInBatch = 0;
  let invalid = 0;
  const chunks = splitPgn(text);
  chunks.forEach((chunk, idx) => {
    const headers = parseHeaders(chunk);
    const siteHeader = headers['Site'] ?? '';
    let site: Site = 'import';
    let id = '';
    let url = trustedGameUrl(siteHeader);
    if (url.includes('lichess.org')) {
      site = 'lichess';
      id = url.split('/').filter(Boolean).pop() ?? '';
    } else if (url.includes('chess.com')) {
      site = 'chesscom';
      id = url.split('/').filter(Boolean).pop() ?? '';
    }
    if (!id) {
      site = 'import';
      id = `pgn-${pgnHash(headers['Event'] + '|' + headers['Date'] + '|' + headers['UTCDate'] + '|' + chunk.replace(/\s+/g, ' ').slice(0, 4000))}`;
      url = '';
    }
    try {
      const rec = buildGameRecord({ site, id, url, pgn: chunk, username: username.trim() || (headers['White'] ?? '') });
      if (seen.has(rec.key)) {
        duplicatesInBatch++;
      } else {
        seen.add(rec.key);
        out.push(rec);
      }
    } catch {
      invalid++;
    }
    if (onProgress && idx % 10 === 0) onProgress({ message: `Parsed ${out.length} games…`, found: out.length });
  });
  onProgress?.({ message: `Parsed ${out.length} games`, found: out.length });
  return { records: out, duplicatesInBatch, invalid };
}

/** Legacy one-shot import kept for programmatic use. */
export function importPgnText(text: string, username: string, onProgress?: (p: FetchProgress) => void): GameRecord[] {
  return parsePgnImports(text, username, onProgress).records;
}
