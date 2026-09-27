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

  it('detects week-over-week improvement and training impact across categories', () => {
    const fen1 = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    const fen2 = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    const fen3 = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 1 5';

    // Week 1 (Jan 5): 2 games, lower accuracy (68%, 70%), 2 hung-piece mistakes each
    const g1 = makeGameAndAnalysis('g1', '2026-01-06', 68, [
      { fen: fen1, category: 'hung-piece' },
      { fen: fen2, category: 'hung-piece' },
    ]);
    const g2 = makeGameAndAnalysis('g2', '2026-01-07', 70, [
      { fen: fen1, category: 'hung-piece' },
      { fen: fen3, category: 'missed-tactic' },
    ]);

    // Week 2 (Jan 12): 2 games, higher accuracy (81%, 83%), only 1 mistake total
    const g3 = makeGameAndAnalysis('g3', '2026-01-13', 81, [{ fen: fen3, category: 'missed-tactic' }]);
    const g4 = makeGameAndAnalysis('g4', '2026-01-14', 83, []);

    const games: Record<string, GameRecord> = {
      g1: g1.game,
      g2: g2.game,
      g3: g3.game,
      g4: g4.game,
    };
    const analyses: Record<string, GameAnalysis> = {
      g1: g1.analysis,
      g2: g2.analysis,
      g3: g3.analysis,
      g4: g4.analysis,
    };
    const trainingStats: Record<string, TrainingStats> = {
      'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -': {
        attempts: 2,
        correct: 2,
        lastResult: 'correct',
        lastAt: Date.UTC(2026, 0, 12),
      },
      'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq -': {
        attempts: 1,
        correct: 1,
        lastResult: 'correct',
        lastAt: Date.UTC(2026, 0, 13),
      },
    };

    const report = computeProgressReport(analyses, games, trainingStats);

    expect(report.weeks).toHaveLength(2);
    expect(report.verdict).toBe('improving');
    expect(report.priorAccuracy).toBe(69);
    expect(report.recentAccuracy).toBe(82);
    expect(report.accuracyDelta).toBe(13);
    expect(report.recentMistakesPer40).toBeLessThan(report.priorMistakesPer40);
    expect(report.mistakesDeltaPct).toBeLessThan(0);
    expect(report.trainedUniqueMistakes).toBe(2);
    expect(report.totalUniqueMistakes).toBe(3);
    expect(report.trainingCoveragePct).toBe(67);
    expect(report.masteryPct).toBe(100);
    expect(report.drilledCategoryDeltaPct).toBe(-100); // hung-piece went from 1.5/game to 0/game!

    const geom = buildChartGeometry(report.chartBuckets);
    expect(geom.nodes).toHaveLength(2);
    expect(geom.accuracyPoints).toContain(',');
  });
});
