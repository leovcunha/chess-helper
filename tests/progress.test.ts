import { describe, expect, it } from 'vitest';
import { buildChartGeometry, computeProgressReport, parseGameTimestamp, weekStartIso } from '../src/lib/progress';
import type { Category, GameAnalysis, GameRecord, PlyAnalysis, TrainingStats } from '../src/types';

function makePly(ply: number, fenBefore: string, category?: Category): PlyAnalysis {
  return {
    ply,
    fenBefore,
    fenAfter: fenBefore,
    playedSan: 'Nf3',
    playedUci: 'g1f3',
    evalBefore: 20,
    evalAfterPlayer: category ? -200 : 20,
    cpl: category ? 220 : 0,
    best: [{ uci: 'e2e4', cp: 20 }],
    category,
    phase: 'middlegame',
  };
}

function makeGameAndAnalysis(
  key: string,
  playedAt: string,
  accuracy: number,
  mistakeFens: { fen: string; category: Category }[],
  totalPlayerMoves = 20
): { game: GameRecord; analysis: GameAnalysis } {
  const plies: PlyAnalysis[] = [];
  for (let i = 0; i < totalPlayerMoves; i++) {
    const plyNo = i * 2 + 1; // odd = white
    const m = mistakeFens[i];
    plies.push(
      makePly(
        plyNo,
        m?.fen ?? `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - ${i} ${i + 1}`,
        m?.category
      )
    );
  }
  return {
    game: {
      key,
      site: 'lichess',
      id: key,
      url: '',
      pgn: '',
      white: 'Me',
      black: 'Opp',
      playerColor: 'w',
      playerResult: 'win',
      timeClass: 'blitz',
      rated: true,
      playedAt,
    },
    analysis: {
      key: `${key}|sf`,
      gameKey: key,
      engineKey: 'sf',
      schema: 7,
      depth: 13,
      mpv: 3,
      playerColor: 'w',
      accuracy,
      plies,
      mistakeCount: mistakeFens.length,
      createdAt: Date.UTC(2026, 0, 10),
    },
  };
}

describe('progress & training effectiveness calculation', () => {
  it('parses PGN and ISO dates and computes Monday week start', () => {
    const ts = parseGameTimestamp('2026.01.08', 0); // Thursday Jan 8, 2026
    expect(weekStartIso(ts)).toBe('2026-01-05'); // Monday Jan 5, 2026
  });

  it('attributes trained exercises strictly to the week the user trained (not the week the game was played)', () => {
    const fen1 = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    const fen2 = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

    // Games were played in Week 1 (Jan 5, 2026)
    const g1 = makeGameAndAnalysis('g1', '2026-01-06', 70, [{ fen: fen1, category: 'hung-piece' }]);
    const g2 = makeGameAndAnalysis('g2', '2026-01-07', 74, [{ fen: fen2, category: 'hung-piece' }]);

    // User actually trained those mistakes 2 weeks later in Week 3 (Jan 19, 2026)
    const trainingStats: Record<string, TrainingStats> = {
      'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -': {
        attempts: 1,
        correct: 1,
        lastResult: 'correct',
        lastAt: Date.UTC(2026, 0, 20), // Jan 20, 2026 -> week of 2026-01-19
      },
      'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq -': {
        attempts: 1,
        correct: 1,
        lastResult: 'correct',
        lastAt: Date.UTC(2026, 0, 21), // Jan 21, 2026 -> week of 2026-01-19
      },
    };

    const report = computeProgressReport(
      { g1: g1.analysis, g2: g2.analysis },
      { g1: g1.game, g2: g2.game },
      trainingStats
    );

    expect(report.weeks).toHaveLength(2);
    // Week 1 (2026-01-05): 2 games played, 0 trained in that week
    expect(report.weeks[0].weekStart).toBe('2026-01-05');
    expect(report.weeks[0].games).toBe(2);
    expect(report.weeks[0].trainedExercises).toBe(0);

    // Week 2 on timeline (2026-01-19): 0 games played, 2 exercises trained in that week
    expect(report.weeks[1].weekStart).toBe('2026-01-19');
    expect(report.weeks[1].games).toBe(0);
    expect(report.weeks[1].trainedExercises).toBe(2);

    // Since no games have been played AFTER Jan 20-21 training, status is 'awaiting-games'
    expect(report.categoryEffectiveness[0].status).toBe('awaiting-games');
    expect(report.categoryEffectiveness[0].afterTrainingPerGame).toBeNull();
  });

  it('measures before-vs-after training impact when new games are played after training', () => {
    const fen1 = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    const fen2 = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    const fen3 = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 1 5';

    // Week 1 (Jan 5): 2 games before training
    const g1 = makeGameAndAnalysis('g1', '2026-01-06', 68, [
      { fen: fen1, category: 'hung-piece' },
      { fen: fen2, category: 'hung-piece' },
    ]);
    const g2 = makeGameAndAnalysis('g2', '2026-01-07', 70, [
      { fen: fen1, category: 'hung-piece' },
      { fen: fen3, category: 'missed-tactic' },
    ]);

    // User trains hung-piece on Jan 10 (Week 1)
    const trainingStats: Record<string, TrainingStats> = {
      'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -': {
        attempts: 2,
        correct: 2,
        lastResult: 'correct',
        lastAt: Date.UTC(2026, 0, 10),
      },
      'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq -': {
        attempts: 1,
        correct: 1,
        lastResult: 'correct',
        lastAt: Date.UTC(2026, 0, 10),
      },
    };

    // Week 2 (Jan 12): 2 games played AFTER training (0 hung pieces!)
    const g3 = makeGameAndAnalysis('g3', '2026-01-13', 81, [{ fen: fen3, category: 'missed-tactic' }]);
    const g4 = makeGameAndAnalysis('g4', '2026-01-14', 83, []);

    const report = computeProgressReport(
      { g1: g1.analysis, g2: g2.analysis, g3: g3.analysis, g4: g4.analysis },
      { g1: g1.game, g2: g2.game, g3: g3.game, g4: g4.game },
      trainingStats
    );

    expect(report.weeks).toHaveLength(2);
    expect(report.verdict).toBe('improving');
    expect(report.drilledCategoryDeltaPct).toBe(-100);

    const hungImpact = report.categoryEffectiveness.find(c => c.category === 'hung-piece')!;
    expect(hungImpact.status).toBe('improved');
    expect(hungImpact.beforeTrainingPerGame).toBe(1.5);
    expect(hungImpact.afterTrainingPerGame).toBe(0);
    expect(hungImpact.deltaPct).toBe(-100);

    const geom = buildChartGeometry(report.chartBuckets);
    expect(geom.nodes).toHaveLength(2);
    expect(geom.accuracyPoints).toContain(',');
  });
});
