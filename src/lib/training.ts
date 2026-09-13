import type { Category, GameAnalysis, GameRecord, TrainingItem, TrainingStats } from '../types';
import { MATE_BASE, getEnginePool } from './engine';
import { gameLabel } from './analysis';

export function posKeyOf(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

export interface CategoryCount {
  key: Category;
  count: number;
}

/**
 * Build the training queue: mistakes grouped so the most common category comes
 * first, positions inside a category ordered by severity (centipawn loss).
 * Duplicate positions across games are deduped, keeping the worst instance.
 *
 * With persisted training history, positions you last got wrong surface first
 * ("due"), and well-mastered ones (several attempts, never wrong) drop to the
 * back of their group.
 */
export function buildTrainingQueue(
  analyses: GameAnalysis[],
  games: Record<string, GameRecord>,
  categoryFilter?: Category[],
  phaseFilter?: string,
  stats?: Record<string, TrainingStats>,
  pieceFilter?: string,
  dismissed?: Record<string, unknown>
): { items: TrainingItem[]; categories: CategoryCount[] } {
  const byCat = new Map<Category, number>();
  const byPos = new Map<string, TrainingItem>();

  for (const a of analyses) {
    const game = games[a.gameKey];
    for (const ply of a.plies) {
      if (!ply.category) continue;
      const key = posKeyOf(ply.fenBefore);
      if (dismissed?.[key]) continue; // user said this label is wrong
      if (categoryFilter && !categoryFilter.includes(ply.category)) continue;
      if (phaseFilter && ply.phase !== phaseFilter) continue;
      if (pieceFilter && ply.hungPiece !== pieceFilter) continue;
      byCat.set(ply.category, (byCat.get(ply.category) ?? 0) + 1);
      const item: TrainingItem = {
        posKey: key,
        fen: ply.fenBefore,
        category: ply.category,
        phase: ply.phase ?? 'middlegame',
        cpl: ply.cpl,
        best: ply.best,
        playedSan: ply.playedSan,
        playedUci: ply.playedUci,
        gameKey: a.gameKey,
        gameLabel: game ? gameLabel(game) : a.gameKey,
        gameUrl: game?.url ?? '',
        hungPiece: ply.hungPiece,
        reason: ply.reason,
        confidence: ply.confidence,
      };
      const existing = byPos.get(key);
      if (!existing || item.cpl > existing.cpl) byPos.set(key, item);
    }
  }

  const categories: CategoryCount[] = [...byCat.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
  const catRank = new Map(categories.map((c, i) => [c.key, i]));
  const now = Date.now();
  const rank = (item: TrainingItem): number => {
    const st = stats?.[item.posKey];
    if (!st || st.attempts === 0) return 0; // never seen — highest priority within its group
    if (st.lastResult === 'wrong') return 1; // got it wrong — due
    const mastered = st.attempts >= 2 && st.correct >= st.attempts;
    // solved before: fresh solves go to the back, stale ones (a week+) come around again
    const ageDays = st.lastAt ? (now - st.lastAt) / 86_400_000 : 0;
    return mastered ? (ageDays >= 7 ? 2 : 3) : ageDays >= 7 ? 1 : 2;
  };
  const items = [...byPos.values()].sort(
    (a, b) =>
      (catRank.get(a.category) ?? 99) - (catRank.get(b.category) ?? 99) ||
      rank(a) - rank(b) ||
      b.cpl - a.cpl
  );
  return { items, categories };
}

export interface GradeOutcome {
  result: 'best' | 'ok' | 'wrong';
  userCp: number; // mover's perspective after their move
  bestCp: number;
  message: string;
}

/**
 * Grade the user's move in a training position. Stored engine lines decide
 * "best"; anything outside them is evaluated quickly by the engine.
 */
export async function gradeMove(
  item: TrainingItem,
  uci: string,
  fenAfter: string,
  terminal: 'checkmate' | 'stalemate' | null,
  depth = 10
): Promise<GradeOutcome> {
  const best = item.best[0];
  const bestCp = best?.cp ?? 0;

  if (terminal === 'checkmate') {
    const userCp = bestCp > 0 && bestCp > MATE_BASE - 10_000 ? bestCp : MATE_BASE - 1;
    return {
      result: 'best',
      userCp,
      bestCp,
      message: 'Checkmate! 🎉',
    };
  }

  if (best && uci === best.uci) {
    return { result: 'best', userCp: bestCp, bestCp, message: "Top move — exactly what the engine wanted." };
  }
  const alternative = item.best.find(l => l.uci === uci);
  if (alternative && best && alternative.cp >= bestCp - 40) {
    return { result: 'best', userCp: alternative.cp, bestCp, message: 'Good move — practically as strong as the best.' };
  }

  let userCp: number;
  if (terminal === 'stalemate') {
    userCp = 0;
  } else {
    try {
      const pool = await getEnginePool();
      const r = await pool.analyze(fenAfter, depth, 1, 10_000);
      userCp = -r.lines[0].cp; // opponent's best eval, negated to the mover's perspective
    } catch {
      return { result: 'wrong', userCp: 0, bestCp, message: 'Could not evaluate that move — try the best line instead.' };
    }
  }

  const diff = Math.max(0, bestCp - userCp);
  if (diff <= 40) {
    return { result: 'ok', userCp, bestCp, message: 'Close enough — only a tiny loss vs the best move.' };
  }
  const bestSan = best?.san ?? best?.uci ?? '?';
  return {
    result: 'wrong',
    userCp,
    bestCp,
    message: `Not quite. Best was ${bestSan}; your move drops about ${(diff / 100).toFixed(1)} pawns.`,
  };
}
