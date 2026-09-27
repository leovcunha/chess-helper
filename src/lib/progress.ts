import type { Category, GameAnalysis, GameRecord, TrainingStats } from '../types';
import { CATEGORY_META, CATEGORY_ORDER } from './classify';
import { posKeyOf } from './training';

export interface WeeklyBucket {
  weekStart: string; // ISO YYYY-MM-DD (Monday)
  label: string; // e.g. "Jan 5"
  games: number;
  avgAccuracy: number; // 0-100, 1 decimal
  mistakes: number;
  playerMoves: number;
  mistakesPerGame: number; // 1 decimal
  mistakesPer40: number; // mistakes per 40 player moves, 1 decimal
  cleanMovePct: number; // % of player moves without errors/blunders, 1 decimal
  trainedExercises: number; // exercises drilled during this week (or from this week's games)
}

export interface CategoryEffectiveness {
  category: Category;
  label: string;
  color: string;
  totalPositions: number;
  trainedPositions: number;
  trainedPct: number;
  masteredPositions: number;
  priorPerGame: number;
  recentPerGame: number;
  deltaPerGame: number; // negative means fewer mistakes per game (improvement)
}

export interface ChartNode {
  key: string;
  label: string;
  sublabel: string;
  avgAccuracy: number;
  mistakesPer40: number;
  trainedExercises: number;
  x: number;
  accY: number;
  errY: number;
  barX: number;
  barY: number;
  barW: number;
  barH: number;
}

export interface ChartGeometry {
  width: number;
  height: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
  plotHeight: number;
  baselineY: number;
  accuracyPoints: string;
  mistakePoints: string;
  nodes: ChartNode[];
}

export interface ProgressReport {
  weeks: WeeklyBucket[];
  chartBuckets: WeeklyBucket[];
  totalGames: number;
  verdict: 'improving' | 'steady' | 'needs-work' | 'insufficient-data';
  headline: string;
  subline: string;
  recentAccuracy: number;
  priorAccuracy: number;
  accuracyDelta: number; // recent - prior (positive = better)
  recentMistakesPer40: number;
  priorMistakesPer40: number;
  mistakesDeltaPct: number; // % change in mistakesPer40 (negative = fewer mistakes = better)
  recentMistakesPerGame: number;
  priorMistakesPerGame: number;
  cleanGamePct: number; // % of analyzed games with <= 1 mistake
  trainingCoveragePct: number; // % of unique mistake positions trained at least once
  masteryPct: number; // % of trained positions whose lastResult === 'correct'
  totalUniqueMistakes: number;
  trainedUniqueMistakes: number;
  masteredUniqueMistakes: number;
  drilledCategoryDeltaPct: number | null; // % change in mistake rate for categories the player has trained
  categoryEffectiveness: CategoryEffectiveness[];
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parse a game's playedAt ("YYYY-MM-DD" or "YYYY.MM.DD") or fallback timestamp into UTC ms. */
export function parseGameTimestamp(playedAt: string | undefined, fallbackMs: number): number {
  if (playedAt) {
    const normalized = playedAt.trim().replace(/\./g, '-');
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(normalized);
    if (m) {
      const y = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10) - 1;
      const d = parseInt(m[3], 10);
      const ts = Date.UTC(y, mo, d);
      if (Number.isFinite(ts) && y >= 1970 && y <= 2100) return ts;
    }
  }
  return fallbackMs || 0;
}

/** Return the ISO date string ("YYYY-MM-DD") for the Monday starting the UTC week of `tsMs`. */
export function weekStartIso(tsMs: number): string {
  const d = new Date(tsMs);
  const day = d.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diffToMon));
  return mon.toISOString().slice(0, 10);
}

/** Format "YYYY-MM-DD" into a compact chart label like "Jan 5". */
export function formatWeekLabel(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return isoDate;
  const monthIdx = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  return `${MONTH_SHORT[monthIdx] ?? m[2]} ${day}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

interface EnrichedGame {
  analysis: GameAnalysis;
  game?: GameRecord;
  ts: number;
  weekStart: string;
  playerMoves: number;
  mistakes: number;
  byCategory: Map<Category, number>;
  trainedInGame: number;
}

/**
 * Compute week-over-week player progress and training effectiveness metrics.
 * Pure calculation module — keeps all business logic out of presentational UI.
 */
export function computeProgressReport(
  analyses: Record<string, GameAnalysis>,
  games: Record<string, GameRecord>,
  trainingStats: Record<string, TrainingStats> = {},
  dismissed: Record<string, unknown> = {}
): ProgressReport {
  const enriched: EnrichedGame[] = [];
  const uniquePositions = new Map<string, Category>();

  for (const a of Object.values(analyses)) {
    const g = games[a.gameKey];
    const ts = parseGameTimestamp(g?.playedAt, a.createdAt);
    const weekStart = weekStartIso(ts);
    let playerMoves = 0;
    let mistakes = 0;
    let trainedInGame = 0;
    const byCategory = new Map<Category, number>();

    for (const p of a.plies) {
      const isPlayerMove = (p.ply % 2 === 1) === (a.playerColor === 'w');
      if (!isPlayerMove || p.evalFailed) continue;
      playerMoves++;
      if (!p.category) continue;
      const posKey = posKeyOf(p.fenBefore);
      if (dismissed[posKey]) continue;
      mistakes++;
      byCategory.set(p.category, (byCategory.get(p.category) ?? 0) + 1);
      if (!uniquePositions.has(posKey)) {
        uniquePositions.set(posKey, p.category);
      }
      if ((trainingStats[posKey]?.attempts ?? 0) > 0) {
        trainedInGame++;
      }
    }

    enriched.push({
      analysis: a,
      game: g,
      ts,
      weekStart,
      playerMoves: Math.max(1, playerMoves),
      mistakes,
      byCategory,
      trainedInGame,
    });
  }

  enriched.sort((a, b) => a.ts - b.ts || a.analysis.gameKey.localeCompare(b.analysis.gameKey));

  // Count exercises drilled per week by trainingStats.lastAt when available
  const drillsByWeek = new Map<string, number>();
  for (const [posKey, st] of Object.entries(trainingStats)) {
    if (dismissed[posKey] || (st?.attempts ?? 0) <= 0) continue;
    if (st.lastAt) {
      const wk = weekStartIso(st.lastAt);
      drillsByWeek.set(wk, (drillsByWeek.get(wk) ?? 0) + 1);
    }
  }

  // Group enriched games by ISO week
  const weekGroups = new Map<string, EnrichedGame[]>();
  for (const eg of enriched) {
    const list = weekGroups.get(eg.weekStart) ?? [];
    list.push(eg);
    weekGroups.set(eg.weekStart, list);
  }

  const weeks: WeeklyBucket[] = [...weekGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, list]) => {
      const gamesCount = list.length;
      const accSum = list.reduce((s, x) => s + x.analysis.accuracy, 0);
      const mistakes = list.reduce((s, x) => s + x.mistakes, 0);
      const playerMoves = list.reduce((s, x) => s + x.playerMoves, 0);
      const trainedFromGames = list.reduce((s, x) => s + x.trainedInGame, 0);
      const trainedByTimestamp = drillsByWeek.get(weekStart) ?? 0;
      const mistakesPer40 = playerMoves > 0 ? round1((mistakes / playerMoves) * 40) : 0;
      const cleanMovePct = playerMoves > 0 ? round1(Math.max(0, 100 - (mistakes / playerMoves) * 100)) : 100;
      return {
        weekStart,
        label: formatWeekLabel(weekStart),
        games: gamesCount,
        avgAccuracy: round1(accSum / gamesCount),
        mistakes,
        playerMoves,
        mistakesPerGame: round1(mistakes / gamesCount),
        mistakesPer40,
        cleanMovePct,
        trainedExercises: Math.max(trainedFromGames, trainedByTimestamp),
      };
    });

  // Unique mistake training stats
  let trainedUniqueMistakes = 0;
  let masteredUniqueMistakes = 0;
  const catPosTotal = new Map<Category, number>();
  const catPosTrained = new Map<Category, number>();
  const catPosMastered = new Map<Category, number>();

  for (const [posKey, cat] of uniquePositions.entries()) {
    catPosTotal.set(cat, (catPosTotal.get(cat) ?? 0) + 1);
    const st = trainingStats[posKey];
    if (st && st.attempts > 0) {
      trainedUniqueMistakes++;
      catPosTrained.set(cat, (catPosTrained.get(cat) ?? 0) + 1);
      if (st.lastResult === 'correct') {
        masteredUniqueMistakes++;
        catPosMastered.set(cat, (catPosMastered.get(cat) ?? 0) + 1);
      }
    }
  }

  const totalUniqueMistakes = uniquePositions.size;
  const trainingCoveragePct =
    totalUniqueMistakes > 0 ? Math.round((trainedUniqueMistakes / totalUniqueMistakes) * 100) : 0;
  const masteryPct =
    trainedUniqueMistakes > 0 ? Math.round((masteredUniqueMistakes / trainedUniqueMistakes) * 100) : 0;

  const cleanGames = enriched.filter(g => g.mistakes <= 1).length;
  const cleanGamePct = enriched.length > 0 ? Math.round((cleanGames / enriched.length) * 100) : 0;

  // Split into prior (baseline) vs recent window:
  // If >= 2 weeks exist, compare the most recent half of weeks (or latest week when 2-3 weeks) against earlier weeks.
  // If all games are in 1 week, split the chronological games in half so trend comparison still works.
  let priorGames: EnrichedGame[] = [];
  let recentGames: EnrichedGame[] = [];

  if (weeks.length >= 2) {
    const splitWeekIdx = weeks.length >= 4 ? Math.floor(weeks.length / 2) : weeks.length - 1;
    const recentWeekSet = new Set(weeks.slice(splitWeekIdx).map(w => w.weekStart));
    priorGames = enriched.filter(g => !recentWeekSet.has(g.weekStart));
    recentGames = enriched.filter(g => recentWeekSet.has(g.weekStart));
  } else if (enriched.length >= 2) {
    const mid = Math.floor(enriched.length / 2);
    priorGames = enriched.slice(0, mid);
    recentGames = enriched.slice(mid);
  } else {
    priorGames = enriched;
    recentGames = enriched;
  }

  const avgAccOf = (list: EnrichedGame[]) =>
    list.length > 0 ? round1(list.reduce((s, g) => s + g.analysis.accuracy, 0) / list.length) : 0;
  const mistakesPer40Of = (list: EnrichedGame[]) => {
    const moves = list.reduce((s, g) => s + g.playerMoves, 0);
    const errs = list.reduce((s, g) => s + g.mistakes, 0);
    return moves > 0 ? round1((errs / moves) * 40) : 0;
  };
  const mistakesPerGameOf = (list: EnrichedGame[]) =>
    list.length > 0 ? round1(list.reduce((s, g) => s + g.mistakes, 0) / list.length) : 0;

  const priorAccuracy = avgAccOf(priorGames);
  const recentAccuracy = avgAccOf(recentGames);
  const accuracyDelta = round1(recentAccuracy - priorAccuracy);

  const priorMistakesPer40 = mistakesPer40Of(priorGames);
  const recentMistakesPer40 = mistakesPer40Of(recentGames);
  const mistakesDeltaPct =
    priorMistakesPer40 > 0
      ? Math.round(((recentMistakesPer40 - priorMistakesPer40) / priorMistakesPer40) * 100)
      : 0;

  const priorMistakesPerGame = mistakesPerGameOf(priorGames);
  const recentMistakesPerGame = mistakesPerGameOf(recentGames);

  // Per-category training effectiveness
  const categoryEffectiveness: CategoryEffectiveness[] = [];
  let drilledPriorSum = 0;
  let drilledRecentSum = 0;
  let hasDrilledCategory = false;

  for (const cat of CATEGORY_ORDER) {
    const totalPos = catPosTotal.get(cat) ?? 0;
    if (totalPos === 0) continue;
    const trainedPos = catPosTrained.get(cat) ?? 0;
    const masteredPos = catPosMastered.get(cat) ?? 0;
    const trainedPct = Math.round((trainedPos / totalPos) * 100);

    const priorCount = priorGames.reduce((s, g) => s + (g.byCategory.get(cat) ?? 0), 0);
    const recentCount = recentGames.reduce((s, g) => s + (g.byCategory.get(cat) ?? 0), 0);
    const priorRate = priorGames.length > 0 ? round1(priorCount / priorGames.length) : 0;
    const recentRate = recentGames.length > 0 ? round1(recentCount / recentGames.length) : 0;
    const deltaRate = round1(recentRate - priorRate);

    if (trainedPos > 0) {
      hasDrilledCategory = true;
      drilledPriorSum += priorRate;
      drilledRecentSum += recentRate;
    }

    categoryEffectiveness.push({
      category: cat,
      label: CATEGORY_META[cat].label,
      color: CATEGORY_META[cat].color,
      totalPositions: totalPos,
      trainedPositions: trainedPos,
      trainedPct,
      masteredPositions: masteredPos,
      priorPerGame: priorRate,
      recentPerGame: recentRate,
      deltaPerGame: deltaRate,
    });
  }

  categoryEffectiveness.sort((a, b) => b.totalPositions - a.totalPositions);

  const drilledCategoryDeltaPct =
    hasDrilledCategory && drilledPriorSum > 0
      ? Math.round(((drilledRecentSum - drilledPriorSum) / drilledPriorSum) * 100)
      : null;

  // Determine overall coaching verdict and headline
  let verdict: ProgressReport['verdict'] = 'steady';
  let headline = 'Steady performance across recent games';
  let subline = 'Keep analyzing and drilling your recurring mistake themes to build a clearer week-over-week trend.';

  if (enriched.length < 2) {
    verdict = 'insufficient-data';
    headline = 'Analyze at least 2 games to unlock trend tracking';
    subline = 'Once you have games across multiple sessions or weeks, your accuracy and mistake reduction trends will appear here.';
  } else {
    const accImproved = accuracyDelta >= 1.0;
    const mistakesReduced = recentMistakesPer40 < priorMistakesPer40 - 0.15;
    const accRegressed = accuracyDelta <= -1.5;
    const mistakesIncreased = recentMistakesPer40 > priorMistakesPer40 + 0.25;

    if (accImproved || mistakesReduced) {
      verdict = 'improving';
      const parts: string[] = [];
      if (accuracyDelta > 0) parts.push(`accuracy is up +${accuracyDelta}%`);
      if (mistakesDeltaPct < 0) parts.push(`mistakes per 40 moves dropped ${Math.abs(mistakesDeltaPct)}%`);
      headline = `Improving trend — ${parts.join(' and ')}`;
      if (drilledCategoryDeltaPct !== null && drilledCategoryDeltaPct < 0) {
        subline = `Training is paying off: mistake frequency in your drilled themes is down ${Math.abs(drilledCategoryDeltaPct)}% (${masteryPct}% mastery across ${trainedUniqueMistakes} trained positions).`;
      } else if (trainedUniqueMistakes > 0) {
        subline = `You've trained ${trainingCoveragePct}% of your mapped mistakes (${masteryPct}% mastered). Keep drilling untrained positions to lock in the gains.`;
      } else {
        subline = `Your game quality is trending upward. Start drilling your mapped mistakes below to accelerate the improvement.`;
      }
    } else if (accRegressed && mistakesIncreased) {
      verdict = 'needs-work';
      headline = `Recent dip — accuracy ${accuracyDelta > 0 ? '+' : ''}${accuracyDelta}%, mistakes +${Math.abs(mistakesDeltaPct)}%`;
      subline =
        trainedUniqueMistakes < totalUniqueMistakes
          ? `You have ${totalUniqueMistakes - trainedUniqueMistakes} untrained mistake positions waiting — a focused training block on your top weakness can reverse the dip.`
          : `Review your most recent games and re-drill the themes that spiked this week.`;
    } else {
      verdict = 'steady';
      headline = `Holding steady around ${recentAccuracy}% accuracy (${recentMistakesPer40} mistakes / 40 moves)`;
      subline =
        trainedUniqueMistakes > 0
          ? `${trainingCoveragePct}% of mistakes trained (${masteryPct}% mastered). Drill the remaining ${totalUniqueMistakes - trainedUniqueMistakes} untrained positions to break through your plateau.`
          : `Train your #1 mistake category below to start pushing your weekly accuracy higher.`;
    }
  }

  let chartBuckets: WeeklyBucket[] = weeks.slice(-10);
  if (weeks.length === 1 && enriched.length >= 2) {
    // When all analyzed games fall within a single week, slice into chronological mini-buckets
    // so the chart still visualizes progression across the week's games.
    const bucketCount = Math.min(6, enriched.length);
    const chunkSize = Math.ceil(enriched.length / bucketCount);
    const intraWeek: WeeklyBucket[] = [];
    for (let i = 0; i < enriched.length; i += chunkSize) {
      const slice = enriched.slice(i, i + chunkSize);
      const gCount = slice.length;
      const accSum = slice.reduce((s, x) => s + x.analysis.accuracy, 0);
      const mistakes = slice.reduce((s, x) => s + x.mistakes, 0);
      const playerMoves = slice.reduce((s, x) => s + x.playerMoves, 0);
      const trainedFromGames = slice.reduce((s, x) => s + x.trainedInGame, 0);
      const firstIdx = i + 1;
      const lastIdx = i + slice.length;
      const label = firstIdx === lastIdx ? `Game ${firstIdx}` : `Games ${firstIdx}–${lastIdx}`;
      intraWeek.push({
        weekStart: `${weeks[0].weekStart}#${firstIdx}`,
        label,
        games: gCount,
        avgAccuracy: round1(accSum / gCount),
        mistakes,
        playerMoves,
        mistakesPerGame: round1(mistakes / gCount),
        mistakesPer40: playerMoves > 0 ? round1((mistakes / playerMoves) * 40) : 0,
        cleanMovePct: playerMoves > 0 ? round1(Math.max(0, 100 - (mistakes / playerMoves) * 100)) : 100,
        trainedExercises: trainedFromGames,
      });
    }
    chartBuckets = intraWeek;
  }

  return {
    weeks,
    chartBuckets,
    totalGames: enriched.length,
    verdict,
    headline,
    subline,
    recentAccuracy,
    priorAccuracy,
    accuracyDelta,
    recentMistakesPer40,
    priorMistakesPer40,
    mistakesDeltaPct,
    recentMistakesPerGame,
    priorMistakesPerGame,
    cleanGamePct,
    trainingCoveragePct,
    masteryPct,
    totalUniqueMistakes,
    trainedUniqueMistakes,
    masteredUniqueMistakes,
    drilledCategoryDeltaPct,
    categoryEffectiveness,
  };
}

/**
 * Compute SVG coordinates for the weekly progress & training chart.
 */
export function buildChartGeometry(buckets: WeeklyBucket[], width = 680, height = 188): ChartGeometry {
  const padLeft = 44;
  const padRight = 36;
  const padTop = 26;
  const padBottom = 42;
  const plotWidth = Math.max(1, width - padLeft - padRight);
  const plotHeight = Math.max(1, height - padTop - padBottom);
  const baselineY = padTop + plotHeight;

  if (buckets.length === 0) {
    return {
      width,
      height,
      padLeft,
      padRight,
      padTop,
      padBottom,
      plotHeight,
      baselineY,
      accuracyPoints: '',
      mistakePoints: '',
      nodes: [],
    };
  }

  // Dynamic accuracy bounds for clear visual separation (clamped within [35, 100])
  const minAcc = Math.max(35, Math.min(65, Math.floor(Math.min(...buckets.map(b => b.avgAccuracy)) - 8)));
  const maxAcc = 100;
  const accSpan = Math.max(10, maxAcc - minAcc);

  const maxErr = Math.max(4, Math.ceil(Math.max(...buckets.map(b => b.mistakesPer40)) * 1.2));
  const maxTrained = Math.max(3, ...buckets.map(b => b.trainedExercises));

  const barW = Math.min(34, Math.max(14, Math.floor(plotWidth / Math.max(2, buckets.length * 2.4))));

  const nodes: ChartNode[] = buckets.map((b, i) => {
    const x =
      buckets.length === 1
        ? padLeft + plotWidth / 2
        : padLeft + (i / (buckets.length - 1)) * plotWidth;
    const accNorm = Math.max(0, Math.min(1, (b.avgAccuracy - minAcc) / accSpan));
    const accY = round1(baselineY - accNorm * plotHeight);

    const errNorm = Math.max(0, Math.min(1, b.mistakesPer40 / maxErr));
    const errY = round1(baselineY - errNorm * (plotHeight * 0.78));

    const trainNorm = Math.max(0, Math.min(1, b.trainedExercises / maxTrained));
    const barH = round1(trainNorm * (plotHeight * 0.55));
    const barY = round1(baselineY - barH);
    const barX = round1(x - barW / 2);

    return {
      key: b.weekStart,
      label: b.label,
      sublabel: `${b.games}g`,
      avgAccuracy: b.avgAccuracy,
      mistakesPer40: b.mistakesPer40,
      trainedExercises: b.trainedExercises,
      x: round1(x),
      accY,
      errY,
      barX,
      barY,
      barW,
      barH,
    };
  });

  const accuracyPoints = nodes.map(n => `${n.x},${n.accY}`).join(' ');
  const mistakePoints = nodes.map(n => `${n.x},${n.errY}`).join(' ');

  return {
    width,
    height,
    padLeft,
    padRight,
    padTop,
    padBottom,
    plotHeight,
    baselineY,
    accuracyPoints,
    mistakePoints,
    nodes,
  };
}

