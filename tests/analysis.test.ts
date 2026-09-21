import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeGames, computeReviewStats, estimateElo } from '../src/lib/analysis';
import type { EnginePool } from '../src/lib/engine';
import type { AnalyzeResult, EngineLine } from '../src/lib/engine';
import { dbBulkPut, dbGet, dbGetAllEntries, dbDelete, dbPut } from '../src/lib/db';
import type { GameRecord } from '../src/types';

const TEST_PGN = `[Event "T"]
[Site "https://lichess.org/test1"]
[Date "2026.01.01"]
[White "Tester"]
[Black "Opponent"]
[Result "0-1"]
[TimeControl "300+0"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Nxd5 6. Nxf7 Kxf7 7. Qf3+ Ke6 8. Nc3 Nb4 9. a3 Nxc2+ 10. Kd1 Nxa1 11. Nxd5 Kd6 12. d4 c5 13. dxc5+ Kxc5 0-1`;

function makeGame(key: string): GameRecord {
  return {
    key,
    site: 'lichess',
    id: key,
    url: '',
    pgn: TEST_PGN,
    white: 'Tester',
    black: 'Opponent',
    playerColor: 'w',
    playerResult: 'loss',
    timeClass: 'blitz',
    rated: true,
    playedAt: '2026.01.01',
  };
}

/** Deterministic fake pool: records concurrency, can fail fens once or forever. */
class FakePool implements Partial<EnginePool> {
  name = 'Fake x2';
  size = 2;
  calls = 0;
  inFlight = 0;
  maxInFlight = 0;
  alwaysFail = new Set<string>();
  failOnce = new Set<string>();
  failedOnce = new Set<string>();
  lines = (fen: string): EngineLine[] => [{ uci: 'g1f3', cp: 30, pv: ['g1f3', 'e7e5'] }];

  async analyze(fen: string): Promise<AnalyzeResult> {
    this.calls++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise(r => setTimeout(r, 2));
    this.inFlight--;
    if (this.alwaysFail.has(fen)) throw new Error('engine boom');
    if (this.failOnce.has(fen) && !this.failedOnce.has(fen)) {
      this.failedOnce.add(fen);
      throw new Error('transient');
    }
    return { lines: this.lines(fen), best: this.lines(fen)[0] };
  }
}

const baseOpts = {
  depth: 10,
  mpv: 3,
  minCpl: 50,
  onProgress: () => {},
  shouldCancel: () => false,
  onGameAnalyzed: () => {},
};

describe('analyzeGames', () => {
  it('analyzes all games and classifies mistakes with a bounded worker count', async () => {
    const pool = new FakePool();
    const persisted: GameAnalysis[] = [];
    const res = await analyzeGames(
      { ...baseOpts, games: [makeGame('g1'), makeGame('g2')], onGameAnalyzed: async a => persisted.push(a) },
      pool as unknown as EnginePool
    );
    expect(res.analyzed).toBe(2);
    expect(res.failed).toBe(0);
    expect(persisted).toHaveLength(2);
    // bounded: never more searches in flight than pool workers
    expect(pool.maxInFlight).toBeLessThanOrEqual(pool.size);
    // the test game has real blunders (9.a3 / 10.Kd1 area) → at least one mapped
    expect(persisted.some(a => a.mistakeCount > 0)).toBe(true);
    // no eval failures with a healthy pool
    expect(persisted.every(a => !a.partial)).toBe(true);
    // failed positions are excluded from the accuracy average
    for (const a of persisted) {
      expect(a.accuracy).toBeGreaterThan(0);
      expect(a.estimatedElo).toBe(estimateElo(a.accuracy, { site: 'lichess', timeClass: 'blitz' }));
    }
  });

  it('retries transient failures once and marks persisting failures as partial', async () => {
    const game = makeGame('g1');
    // fail exactly one fen forever: find the position after 1.e4 via the parser? simpler —
    // fail the very first fen (start position) → ply 1 is affected
    const pool = new FakePool();
    pool.alwaysFail.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    const persisted: GameAnalysis[] = [];
    const res = await analyzeGames(
      { ...baseOpts, games: [game], onGameAnalyzed: async a => persisted.push(a) },
      pool as unknown as EnginePool
    );
    expect(res.analyzed).toBe(0);
    expect(res.partial).toBe(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].partial).toBe(true);
    // the failed ply is marked and has no category (never counted as a perfect move)
    const failedPly = persisted[0].plies.find(p => p.evalFailed);
    expect(failedPly).toBeDefined();
    expect(failedPly!.category).toBeUndefined();
  });

  it('retries a transient failure successfully', async () => {
    const pool = new FakePool();
    pool.failOnce.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    const persisted: GameAnalysis[] = [];
    const res = await analyzeGames(
      { ...baseOpts, games: [makeGame('g1')], onGameAnalyzed: async a => persisted.push(a) },
      pool as unknown as EnginePool
    );
    expect(res.partial).toBe(0);
    expect(pool.calls).toBeGreaterThanOrEqual(28); // 27 positions + 1 retry
    expect(persisted[0].plies.every(p => !p.evalFailed)).toBe(true);
  });

  it('stops quickly on cancel and does not persist unfinished games', async () => {
    const pool = new FakePool();
    pool.size = 2;
    const opts = {
      ...baseOpts,
      games: [makeGame('g1'), makeGame('g2'), makeGame('g3')],
      // cancel as soon as 5 searches have run (2 in flight finish, the rest abort)
      shouldCancel: () => pool.calls >= 5,
      onGameAnalyzed: async () => {},
    };
    const t0 = Date.now();
    const res = await analyzeGames(opts, pool as unknown as EnginePool);
    const elapsed = Date.now() - t0;
    expect(res.cancelled).toBe(true);
    // the queue drains only what's in flight: a handful of searches run, not 87
    expect(pool.calls).toBeLessThanOrEqual(10);
    expect(elapsed).toBeLessThan(2000);
    // no game finished all of its searches, so nothing is persisted
    expect(res.analyzed).toBe(0);
  });

  it('reports unparseable PGNs as failures without blocking other games', async () => {
    const bad = { ...makeGame('bad'), pgn: '[Event "x"]\n[White "a"]\n[Black "b"]\n1. zz zzz *' };
    const pool = new FakePool();
    const persisted: GameAnalysis[] = [];
    const res = await analyzeGames(
      { ...baseOpts, games: [bad, makeGame('good')], onGameAnalyzed: async a => persisted.push(a) },
      pool as unknown as EnginePool
    );
    expect(res.failed).toBe(1);
    expect(res.failures[0].reason).toMatch(/illegal move|no moves/);
    expect(persisted).toHaveLength(1);
  });
});

describe('indexeddb wrapper', () => {
  beforeEach(async () => {
    await dbBulkPut('games', [
      ['a', { key: 'a' } as GameRecord],
      ['b', { key: 'b' } as GameRecord],
    ]);
  });

  afterEach(async () => {
    await dbDelete('games', 'a');
    await dbDelete('games', 'b');
    await dbDelete('games', 'c');
  });

  it('puts, gets and deletes by key', async () => {
    expect((await dbGet<GameRecord>('games', 'a'))?.key).toBe('a');
    await dbPut('games', 'c', { key: 'c' } as GameRecord);
    expect((await dbGet<GameRecord>('games', 'c'))?.key).toBe('c');
    await dbDelete('games', 'c');
    expect(await dbGet('games', 'c')).toBeUndefined();
  });

  it('lists entries with keys (needed for training stats)', async () => {
    await dbPut('training', 'pos-1', { attempts: 2, correct: 1, lastResult: 'correct' });
    const entries = await dbGetAllEntries('training');
    const found = entries.find(([k]) => k === 'pos-1');
    expect(found?.[1].attempts).toBe(2);
    await dbDelete('training', 'pos-1');
  });
});

describe('computeReviewStats', () => {
  it('handles empty rows gracefully', () => {
    const stats = computeReviewStats([]);
    expect(stats).toEqual({
      totalGames: 0,
      analyzedGames: 0,
      avgAccuracy: 0,
      avgRating: 0,
      bySite: {},
      ratingDisplay: '—',
    });
  });

  it('ignores unanalyzed games when computing averages', () => {
    const game1 = makeGame('g1');
    const game2 = makeGame('g2');
    const stats = computeReviewStats([
      { game: game1, analysis: undefined },
      { game: game2, analysis: undefined },
    ]);
    expect(stats).toEqual({
      totalGames: 2,
      analyzedGames: 0,
      avgAccuracy: 0,
      avgRating: 0,
      bySite: {},
      ratingDisplay: '—',
    });
  });

  it('computes clean single-site average rating when only one platform is present', () => {
    const game1 = { ...makeGame('g1'), site: 'lichess' as const, timeClass: 'rapid' as const, playerRating: 1050, opponentRating: 1050 };
    const analysis1 = { accuracy: 67 } as unknown as import('../src/types').GameAnalysis;

    const stats = computeReviewStats([{ game: game1, analysis: analysis1 }]);
    expect(stats.avgRating).toBe(1050);
    expect(stats.ratingDisplay).toBe('1050');
    expect(stats.bySite.lichess?.avgRating).toBe(1050);
  });

  it('separates Lichess and Chess.com ratings and avoids mixing incompatible rating pools', () => {
    const lichessGame = { ...makeGame('g1'), site: 'lichess' as const, timeClass: 'rapid' as const, playerRating: 1050, opponentRating: 1050 };
    const chesscomGame = { ...makeGame('g2'), site: 'chesscom' as const, timeClass: 'rapid' as const, playerRating: 500, opponentRating: 500 };
    const unanalyzedGame = { ...makeGame('g3'), site: 'lichess' as const, timeClass: 'rapid' as const };

    // At 1050 on Lichess Rapid, expected accuracy is 67%. Playing at 67% -> 1050 performance
    const analysis1 = {
      accuracy: 67,
    } as unknown as import('../src/types').GameAnalysis;

    // At 500 on Chess.com Rapid, expected accuracy is 60%. Playing at 60% -> 500 performance
    const analysis2 = {
      accuracy: 60,
    } as unknown as import('../src/types').GameAnalysis;

    const stats = computeReviewStats([
      { game: lichessGame, analysis: analysis1 },
      { game: chesscomGame, analysis: analysis2 },
      { game: unanalyzedGame, analysis: undefined }, // unanalyzed
    ]);

    expect(stats.totalGames).toBe(3);
    expect(stats.analyzedGames).toBe(2);
    expect(stats.avgAccuracy).toBe(63.5); // (67 + 60) / 2
    // Each platform maintains its own accurate average
    expect(stats.bySite.lichess?.avgRating).toBe(1050);
    expect(stats.bySite.chesscom?.avgRating).toBe(500);
    // ratingDisplay explicitly separates the platforms
    expect(stats.ratingDisplay).toBe('Lichess: 1050 · Chess.com: 500');
    // avgRating normalizes Chess.com 500 (~820 Lichess Rapid equivalent) to avoid bogus 775 average
    expect(stats.avgRating).toBe(935);
  });
});

