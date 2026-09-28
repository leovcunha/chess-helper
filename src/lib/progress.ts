import type { Category, GameAnalysis, GameRecord, TrainingStats } from '../types';
import { CATEGORY_META, CATEGORY_ORDER } from './classify';
import { posKeyOf } from './training';

export interface WeeklyBucket {
  weekStart: string; // ISO YYYY-MM-DD (Monday)
  label: string; // e.g. "Sep 21"
  games: number; // number of analyzed games played in this week
  avgAccuracy: number | null; // 0-100 (1 decimal), or null if no games played this week
  mistakes: number;
  playerMoves: number;
  mistakesPerGame: number | null; // 1 decimal, or null if no games played this week
  mistakesPer40: number | null; // mistakes per 40 player moves (1 decimal), or null if no games
  cleanMovePct: number | null; // % of player moves without errors/blunders
  trainedExercises: number; // exercises actually trained during this week (from TrainingStats.lastAt)
  solvedExercises: number; // exercises trained during this week whose lastResult === 'correct'
}

export type ThemeImpactStatus = 'improved' | 'regressed' | 'steady' | 'awaiting-games' | 'untrained';

export interface CategoryEffectiveness {
  category: Category;
  icon: string;
  label: string;
  color: string;
  totalPositions: number;
  trainedPositions: number;
  trainedPct: number;
  masteredPositions: number;
  overallPerGame: number;
  beforeTrainingPerGame: number;
  afterTrainingPerGame: number | null; // null if no games have been played since training this theme
  gamesBeforeTraining: number;
  gamesAfterTraining: number;
  deltaPerGame: number | null; // after - before (negative = fewer mistakes = improvement)
  deltaPct: number | null; // % change after training (negative = fewer mistakes)
  status: ThemeImpactStatus;
}

export interface ChartNode {
  key: string;
  label: string;
  gamesCount: number;
  avgAccuracy: number | null;
  mistakesPer40: number | null;
  mistakesPerGame: number | null;
  trainedExercises: number;
  x: number;
  accY: number | null;
  errY: number | null;
  accLabelY: number | null; // value label sits above the accuracy point
  errLabelY: number | null; // value label sits on the free side of the mistake point
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
  drilledCategoryDeltaPct: number | null; // % change in post-training games for drilled categories
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

/** Return the UTC day start (00:00:00.000 UTC) for a timestamp in ms. */
function utcDayStart(tsMs: number): number {
  const d = new Date(tsMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Return the ISO date string ("YYYY-MM-DD") for the Monday starting the UTC week of `tsMs`. */
export function weekStartIso(tsMs: number): string {
  const d = new Date(tsMs);
  const day = d.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diffToMon));
  return mon.toISOString().slice(0, 10);
}

/** Format "YYYY-MM-DD" into a compact chart label like "Sep 21". */
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
  dayStart: number;
  weekStart: string;
  playerMoves: number;
  mistakes: number;
  byCategory: Map<Category, number>;
}

/**
 * Compute week-over-week player progress and training effectiveness metrics.
 * Training activity is grouped strictly by the week the user actually trained
 * (`trainingStats[posKey].lastAt`), never by the week the game was played.
 */
export function computeProgressReport(
  analyses: Record<string, GameAnalysis>,
  games: Record<string, GameRecord>,
  trainingStats: Record<string, TrainingStats> = {},
  dismissed: Record<string, unknown> = {}
): ProgressReport {
  const enriched: EnrichedGame[] = [];
  // Track unique mistake positions and the latest game timestamp where each occurred
  const uniquePositions = new Map<string, { category: Category; earliestGameDay: number }>();

  for (const a of Object.values(analyses)) {
    const g = games[a.gameKey];
    const ts = parseGameTimestamp(g?.playedAt, a.createdAt);
    const dayStart = utcDayStart(ts);
    const weekStart = weekStartIso(ts);
    let playerMoves = 0;
    let mistakes = 0;
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
      const existing = uniquePositions.get(posKey);
      if (!existing) {
        uniquePositions.set(posKey, { category: p.category, earliestGameDay: dayStart });
      } else if (dayStart < existing.earliestGameDay) {
        existing.earliestGameDay = dayStart;
      }
    }

    enriched.push({
      analysis: a,
      game: g,
      ts,
      dayStart,
      weekStart,
      playerMoves: Math.max(1, playerMoves),
      mistakes,
      byCategory,
    });
  }

  enriched.sort((a, b) => a.ts - b.ts || a.analysis.gameKey.localeCompare(b.analysis.gameKey));

  // Count exercises trained per week strictly by when the user trained them (`st.lastAt`).
  const drillsByWeek = new Map<string, { trained: number; solved: number }>();
  for (const [posKey, st] of Object.entries(trainingStats)) {
    if (dismissed[posKey] || (st?.attempts ?? 0) <= 0) continue;
    // Only count positions that belong to the current mistake map (or all trained positions with a timestamp)
    if (!st.lastAt) continue;
    const wk = weekStartIso(st.lastAt);
    const prev = drillsByWeek.get(wk) ?? { trained: 0, solved: 0 };
    prev.trained += 1;
    if (st.lastResult === 'correct') prev.solved += 1;
    drillsByWeek.set(wk, prev);
  }

  // Group enriched games by ISO week
  const weekGroups = new Map<string, EnrichedGame[]>();
  for (const eg of enriched) {
    const list = weekGroups.get(eg.weekStart) ?? [];
    list.push(eg);
    weekGroups.set(eg.weekStart, list);
  }

  // Union of all weeks where games were played OR exercises were trained
  const allWeekKeys = new Set<string>([...weekGroups.keys(), ...drillsByWeek.keys()]);
  const sortedWeekKeys = [...allWeekKeys].sort((a, b) => a.localeCompare(b));

  const weeks: WeeklyBucket[] = sortedWeekKeys.map(weekStart => {
    const list = weekGroups.get(weekStart) ?? [];
    const drills = drillsByWeek.get(weekStart) ?? { trained: 0, solved: 0 };
    const gamesCount = list.length;
    if (gamesCount === 0) {
      return {
        weekStart,
        label: formatWeekLabel(weekStart),
        games: 0,
        avgAccuracy: null,
        mistakes: 0,
        playerMoves: 0,
        mistakesPerGame: null,
        mistakesPer40: null,
        cleanMovePct: null,
        trainedExercises: drills.trained,
        solvedExercises: drills.solved,
      };
    }
    const accSum = list.reduce((s, x) => s + x.analysis.accuracy, 0);
    const mistakes = list.reduce((s, x) => s + x.mistakes, 0);
    const playerMoves = list.reduce((s, x) => s + x.playerMoves, 0);
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
      trainedExercises: drills.trained,
      solvedExercises: drills.solved,
    };
  });

  // Unique mistake training stats and earliest training date per category
  let trainedUniqueMistakes = 0;
  let masteredUniqueMistakes = 0;
  const catPosTotal = new Map<Category, number>();
  const catPosTrained = new Map<Category, number>();
  const catPosMastered = new Map<Category, number>();
  const catEarliestTrainedDay = new Map<Category, number>();

  for (const [posKey, { category: cat }] of uniquePositions.entries()) {
    catPosTotal.set(cat, (catPosTotal.get(cat) ?? 0) + 1);
    const st = trainingStats[posKey];
    if (st && st.attempts > 0) {
      trainedUniqueMistakes++;
      catPosTrained.set(cat, (catPosTrained.get(cat) ?? 0) + 1);
      if (st.lastResult === 'correct') {
        masteredUniqueMistakes++;
        catPosMastered.set(cat, (catPosMastered.get(cat) ?? 0) + 1);
      }
      if (st.lastAt) {
        const trainDay = utcDayStart(st.lastAt);
        const prevMin = catEarliestTrainedDay.get(cat);
        if (prevMin === undefined || trainDay < prevMin) {
          catEarliestTrainedDay.set(cat, trainDay);
        }
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

  // Split games into prior (earlier weeks) vs recent (latest week(s) with games)
  const gameWeeks = weeks.filter(w => w.games > 0);
  let priorGames: EnrichedGame[] = [];
  let recentGames: EnrichedGame[] = [];

  if (gameWeeks.length >= 2) {
    const splitWeekIdx = gameWeeks.length >= 4 ? Math.floor(gameWeeks.length / 2) : gameWeeks.length - 1;
    const recentWeekSet = new Set(gameWeeks.slice(splitWeekIdx).map(w => w.weekStart));
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

  // Per-category training effectiveness:
  // Compare games played BEFORE the user trained that category vs games played AFTER training it.
  const categoryEffectiveness: CategoryEffectiveness[] = [];
  let drilledBeforeSum = 0;
  let drilledAfterSum = 0;
  let hasMeasuredDrilledCategory = false;

  for (const cat of CATEGORY_ORDER) {
    const totalPos = catPosTotal.get(cat) ?? 0;
    if (totalPos === 0) continue;
    const trainedPos = catPosTrained.get(cat) ?? 0;
    const masteredPos = catPosMastered.get(cat) ?? 0;
    const trainedPct = Math.round((trainedPos / totalPos) * 100);

    const totalCatMistakes = enriched.reduce((s, g) => s + (g.byCategory.get(cat) ?? 0), 0);
    const overallPerGame = enriched.length > 0 ? round1(totalCatMistakes / enriched.length) : 0;

    const earliestTrainDay = catEarliestTrainedDay.get(cat);
    let beforeList = enriched;
    let afterList: EnrichedGame[] = [];

    if (trainedPos > 0 && earliestTrainDay !== undefined) {
      // Games played strictly after the day training began (or if games were played on a later date)
      // count as post-training games; games on or before the training day are pre-training baseline.
      const strictlyAfter = enriched.filter(g => g.dayStart > earliestTrainDay);
      const onOrBefore = enriched.filter(g => g.dayStart <= earliestTrainDay);
      if (strictlyAfter.length > 0 && onOrBefore.length > 0) {
        beforeList = onOrBefore;
        afterList = strictlyAfter;
      } else {
        // All games were played on or before the day the user trained -> no post-training games yet
        beforeList = enriched;
        afterList = [];
      }
    }

    const beforeCount = beforeList.reduce((s, g) => s + (g.byCategory.get(cat) ?? 0), 0);
    const beforePerGame = beforeList.length > 0 ? round1(beforeCount / beforeList.length) : overallPerGame;

    let afterPerGame: number | null = null;
    let deltaPerGame: number | null = null;
    let deltaPct: number | null = null;
    let status: ThemeImpactStatus = 'untrained';

    if (trainedPos === 0) {
      status = 'untrained';
    } else if (afterList.length === 0) {
      status = 'awaiting-games';
    } else {
      const afterCount = afterList.reduce((s, g) => s + (g.byCategory.get(cat) ?? 0), 0);
      afterPerGame = round1(afterCount / afterList.length);
      deltaPerGame = round1(afterPerGame - beforePerGame);
      deltaPct = beforePerGame > 0 ? Math.round(((afterPerGame - beforePerGame) / beforePerGame) * 100) : 0;
      if (deltaPerGame <= -0.1) status = 'improved';
      else if (deltaPerGame >= 0.1) status = 'regressed';
      else status = 'steady';

      hasMeasuredDrilledCategory = true;
      drilledBeforeSum += beforePerGame;
      drilledAfterSum += afterPerGame;
    }

    categoryEffectiveness.push({
      category: cat,
      icon: CATEGORY_META[cat].icon,
      label: CATEGORY_META[cat].label,
      color: CATEGORY_META[cat].color,
      totalPositions: totalPos,
      trainedPositions: trainedPos,
      trainedPct,
      masteredPositions: masteredPos,
      overallPerGame,
      beforeTrainingPerGame: beforePerGame,
      afterTrainingPerGame: afterPerGame,
      gamesBeforeTraining: beforeList.length,
      gamesAfterTraining: afterList.length,
      deltaPerGame,
      deltaPct,
      status,
    });
  }

  categoryEffectiveness.sort((a, b) => b.totalPositions - a.totalPositions);

  const drilledCategoryDeltaPct =
    hasMeasuredDrilledCategory && drilledBeforeSum > 0
      ? Math.round(((drilledAfterSum - drilledBeforeSum) / drilledBeforeSum) * 100)
      : null;

  // Determine overall coaching verdict and headline
  let verdict: ProgressReport['verdict'] = 'steady';
  let headline = 'Steady performance across recent games';
  let subline = 'Keep analyzing and drilling your recurring mistake themes to build a clearer week-over-week trend.';

  if (enriched.length < 2) {
    verdict = 'insufficient-data';
    headline = 'Analyze at least 2 games to unlock trend tracking';
    subline = 'Once you have games across multiple weeks, your accuracy and mistake reduction trends will appear here.';
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
        subline = `Training is paying off: in games played after training, mistake frequency in your drilled themes is down ${Math.abs(drilledCategoryDeltaPct)}%.`;
      } else if (trainedUniqueMistakes > 0) {
        subline = `You've trained ${trainedUniqueMistakes} of ${totalUniqueMistakes} mistake positions (${masteryPct}% solved). Play and import new games to see how this week's training lowers your mistake rate.`;
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
      headline = `Holding steady around ${recentAccuracy}% accuracy (${recentMistakesPer40} mistakes per 40 moves)`;
      subline =
        trainedUniqueMistakes > 0
          ? `${trainedUniqueMistakes} of ${totalUniqueMistakes} mistakes trained (${masteryPct}% solved). Play new games after your training sessions to track how your mistake rate responds.`
          : `Train your #1 mistake category below to start pushing your weekly accuracy higher.`;
    }
  }

  // Always use real calendar weeks for chartBuckets (up to the last 10 active weeks)
  const chartBuckets: WeeklyBucket[] = weeks.slice(-10);

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
 * Supports weeks with games only, training only, or both.
 */
export function buildChartGeometry(buckets: WeeklyBucket[], width = 920, height = 250): ChartGeometry {
  const padLeft = 48;
  const padRight = 48;
  const padTop = 28;
  const padBottom = 52;
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

  const accValues = buckets.map(b => b.avgAccuracy).filter((v): v is number => v !== null);
  const errValues = buckets.map(b => b.mistakesPer40).filter((v): v is number => v !== null);

  const minAcc =
    accValues.length > 0 ? Math.max(35, Math.min(65, Math.floor(Math.min(...accValues) - 8))) : 50;
  const maxAcc = 100;
  const accSpan = Math.max(10, maxAcc - minAcc);

  const maxErr = errValues.length > 0 ? Math.max(4, Math.ceil(Math.max(...errValues) * 1.2)) : 5;
  const maxTrained = Math.max(3, ...buckets.map(b => b.trainedExercises));

  const barW = Math.min(36, Math.max(16, Math.floor(plotWidth / Math.max(2, buckets.length * 2.4))));

  const nodes: ChartNode[] = buckets.map((b, i) => {
    const x =
      buckets.length === 1
        ? padLeft + plotWidth / 2
        : padLeft + (i / (buckets.length - 1)) * plotWidth;

    let accY: number | null = null;
    if (b.avgAccuracy !== null) {
      const accNorm = Math.max(0, Math.min(1, (b.avgAccuracy - minAcc) / accSpan));
      accY = round1(baselineY - accNorm * plotHeight);
    }

    let errY: number | null = null;
    if (b.mistakesPer40 !== null) {
      const errNorm = Math.max(0, Math.min(1, b.mistakesPer40 / maxErr));
      errY = round1(baselineY - errNorm * (plotHeight * 0.78));
    }

    // Value labels: accuracy above its point; the mistake label goes below its
    // point unless that collides with the accuracy label (mistake point just
    // above the accuracy point) or runs past the baseline — then it goes above.
    const accLabelY = accY !== null ? Math.max(12, round1(accY - 8)) : null;
    let errLabelY: number | null = null;
    if (errY !== null) {
      const below = round1(errY + 13);
      const collidesWithAcc = accY !== null && errY > accY - 21 && errY < accY - 8;
      errLabelY = below > baselineY + 6 || collidesWithAcc ? round1(errY - 8) : below;
    }

    const trainNorm = Math.max(0, Math.min(1, b.trainedExercises / maxTrained));
    const barH = b.trainedExercises > 0 ? Math.max(8, round1(trainNorm * (plotHeight * 0.6))) : 0;
    const barY = round1(baselineY - barH);
    const barX = round1(x - barW / 2);

    return {
      key: b.weekStart,
      label: b.label,
      gamesCount: b.games,
      avgAccuracy: b.avgAccuracy,
      mistakesPer40: b.mistakesPer40,
      mistakesPerGame: b.mistakesPerGame,
      trainedExercises: b.trainedExercises,
      x: round1(x),
      accY,
      errY,
      accLabelY,
      errLabelY,
      barX,
      barY,
      barW,
      barH,
    };
  });

  const accuracyPoints = nodes
    .filter(n => n.accY !== null)
    .map(n => `${n.x},${n.accY}`)
    .join(' ');
  const mistakePoints = nodes
    .filter(n => n.errY !== null)
    .map(n => `${n.x},${n.errY}`)
    .join(' ');

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
