import { describe, expect, it } from 'vitest';
import {
  moveAccuracy,
  calculateGameAccuracy,
  classifyMove,
  reclassifyAnalysis,
  ANALYSIS_SCHEMA,
  chesscomToLichess,
  estimateElo,
  EXPECTED_ACCURACY_BY_RATING,
  expectedAccuracyForRating,
  lichessToChesscom,
  ratingForAccuracy,
} from '../src/lib/classify';
import { encodeScore, isMateScore, MATE_BASE } from '../src/lib/engine';
import type { GameAnalysis } from '../src/types';

describe('moveAccuracy', () => {
  it('gives identical accuracy for identical relative drops, regardless of color', () => {
    // a blunder: mover-relative eval goes from +50 to -400
    const white = moveAccuracy(50, -400, 'w');
    const black = moveAccuracy(50, -400, 'b');
    expect(black).toBeCloseTo(white, 6);
    expect(white).toBeLessThan(90); // clearly not "100% accurate"
  });

  it('does not inflate black accuracy for black blunders', () => {
    // black (mover-relative) goes from -30 to -600 (losing a piece for nothing)
    const acc = moveAccuracy(-30, -600, 'b');
    expect(acc).toBeLessThan(80);
    // and a black improvement is not punished
    const improved = moveAccuracy(-600, -30, 'b');
    expect(improved).toBeGreaterThan(moveAccuracy(-30, -600, 'b'));
  });

  it('handles mate-encoded scores symmetrically', () => {
    const mateForWhite = encodeScore(3, null); // white mates in 3
    const whiteHadMate = moveAccuracy(mateForWhite, 100, 'w'); // throws the mate away
    const mateForBlack = encodeScore(3, null); // +3 from black's perspective: black mates in 3
    const blackHadMate = moveAccuracy(mateForBlack, -100, 'b'); // throws the mate away
    expect(whiteHadMate).toBeLessThan(40);
    expect(blackHadMate).toBeLessThan(40);
  });

  it('clamps perfect and catastrophic moves', () => {
    expect(moveAccuracy(0, 0, 'w')).toBeGreaterThan(99);
    expect(moveAccuracy(100, -900, 'b')).toBeLessThan(10);
  });
});

describe('calculateGameAccuracy', () => {
  it('returns 100% for all-perfect moves', () => {
    const moves = Array.from({ length: 15 }, () => ({
      evalBefore: 30,
      evalAfterPlayer: 30,
      color: 'w' as const,
    }));
    expect(calculateGameAccuracy(moves)).toBe(100);
  });

  it('properly penalizes blunders via harmonic weighting instead of inflating like an arithmetic mean', () => {
    // 20 moves: 14 good moves (eval 0 -> 0), 2 inaccuracies (eval 0 -> -60), 2 mistakes (eval 0 -> -200), 2 blunders (eval 0 -> -600)
    const moves: { evalBefore: number; evalAfterPlayer: number; color: 'w' | 'b' }[] = [
      ...Array.from({ length: 14 }, () => ({ evalBefore: 0, evalAfterPlayer: 0, color: 'w' as const })),
      ...Array.from({ length: 2 }, () => ({ evalBefore: 0, evalAfterPlayer: -60, color: 'w' as const })),
      ...Array.from({ length: 2 }, () => ({ evalBefore: 0, evalAfterPlayer: -200, color: 'w' as const })),
      ...Array.from({ length: 2 }, () => ({ evalBefore: 0, evalAfterPlayer: -600, color: 'w' as const })),
    ];

    // Under simple arithmetic mean, 14 perfect moves would mask the 4 blunders/mistakes, yielding ~84%
    const individualAccuracies = moves.map(m => moveAccuracy(m.evalBefore, m.evalAfterPlayer, m.color));
    const arithmeticMean = individualAccuracies.reduce((a, b) => a + b, 0) / moves.length;
    expect(arithmeticMean).toBeGreaterThan(80);

    // Under official Lichess harmonic & volatility-weighted game accuracy, it is properly dragged down
    const gameAcc = calculateGameAccuracy(moves);
    expect(gameAcc).toBeLessThan(75);
    expect(gameAcc).toBeGreaterThan(50);
  });
});

describe('platform rating conversions', () => {
  it('converts Chess.com Rapid ratings to Lichess Rapid ratings based on empirical curves', () => {
    // 500 Chess.com Rapid maps to 820 Lichess Rapid
    expect(chesscomToLichess(500, 'rapid')).toBe(820);
    // 1000 Chess.com Rapid maps to 1280 Lichess Rapid
    expect(chesscomToLichess(1000, 'rapid')).toBe(1280);
    // 2000 Chess.com Rapid maps to 2175 Lichess Rapid
    expect(chesscomToLichess(2000, 'rapid')).toBe(2175);
    // Master ratings converge
    expect(chesscomToLichess(2800, 'rapid')).toBe(2800);
  });

  it('converts Chess.com Blitz ratings to Lichess Blitz ratings', () => {
    // 500 Chess.com Blitz maps to ~980 Lichess Blitz
    expect(chesscomToLichess(500, 'blitz')).toBe(980);
    expect(chesscomToLichess(1000, 'blitz')).toBe(1420);
  });

  it('converts Lichess ratings to Chess.com ratings inversely', () => {
    expect(lichessToChesscom(820, 'rapid')).toBe(500);
    expect(lichessToChesscom(1280, 'rapid')).toBe(1000);
    expect(lichessToChesscom(980, 'blitz')).toBe(500);
  });
});

describe('estimateElo', () => {
  it('evaluates match performance relative to player rating on Lichess in Rapid (~1050)', () => {
    // Expected accuracy for ~1050 on Lichess Rapid is 67%
    const expected = expectedAccuracyForRating(1050, 'lichess', 'rapid');
    expect(expected).toBe(67);

    // Normal game: played at expected accuracy -> rating stays at ~1050
    const normal = estimateElo(67, { site: 'lichess', timeClass: 'rapid', playerRating: 1050, moveCount: 20 });
    expect(normal).toBe(1050);

    // Strong game (+10% accuracy above expected: 77%) -> performance is ~1300
    const strong = estimateElo(77, { site: 'lichess', timeClass: 'rapid', playerRating: 1050, moveCount: 20 });
    expect(strong).toBe(1300);
  });

  it('evaluates match performance relative to player rating on Chess.com in Rapid (~500)', () => {
    // Expected accuracy for ~500 on Chess.com Rapid is 60%
    const expected = expectedAccuracyForRating(500, 'chesscom', 'rapid');
    expect(expected).toBe(60);

    // Normal game: played at expected accuracy -> rating stays at ~500
    const normal = estimateElo(60, { site: 'chesscom', timeClass: 'rapid', playerRating: 500, moveCount: 20 });
    expect(normal).toBe(500);

    // Great game for a 500 (+12% accuracy: 72%) -> performance ~800, NOT inflated to 1500+
    const strong = estimateElo(72, { site: 'chesscom', timeClass: 'rapid', playerRating: 500, moveCount: 20 });
    expect(strong).toBe(800);
  });

  it('distinguishes Rapid expected accuracy between 500 Chess.com vs 820 Lichess', () => {
    expect(expectedAccuracyForRating(500, 'chesscom', 'rapid')).toBe(60);
    expect(expectedAccuracyForRating(820, 'lichess', 'rapid')).toBe(60);
  });

  it('smoothly estimates unanchored rating when no match rating exists', () => {
    expect(estimateElo(0, { site: 'chesscom', timeClass: 'rapid' })).toBe(100);
    expect(estimateElo(60, { site: 'chesscom', timeClass: 'rapid' })).toBe(500);
    expect(estimateElo(97, { site: 'chesscom', timeClass: 'rapid' })).toBe(2800);

    expect(estimateElo(0, { site: 'lichess', timeClass: 'rapid' })).toBe(100);
    expect(estimateElo(60, { site: 'lichess', timeClass: 'rapid' })).toBe(820);
    expect(estimateElo(97, { site: 'lichess', timeClass: 'rapid' })).toBe(2800);
  });

  it('is monotonically non-decreasing across 0 to 100 unanchored accuracy for both platforms', () => {
    for (const site of ['lichess' as const, 'chesscom' as const]) {
      let prev = estimateElo(0, { site, timeClass: 'rapid' });
      for (let acc = 1; acc <= 100; acc += 0.5) {
        const current = estimateElo(acc, { site, timeClass: 'rapid' });
        expect(current).toBeGreaterThanOrEqual(prev);
        prev = current;
      }
    }
  });
});

describe('mate score encoding', () => {
  it('negates consistently between mover and opponent perspectives', () => {
    const forMover = encodeScore(5, null); // mover mates in 5
    const againstMover = encodeScore(-5, null); // mover gets mated in 5
    expect(isMateScore(forMover)).toBe(true);
    expect(isMateScore(againstMover)).toBe(true);
    // opponent-relative = mover-relative negated (what analysis.ts relies on)
    expect(againstMover).toBe(-forMover);
    expect(Math.abs(forMover)).toBe(Math.abs(againstMover));
  });

  it('keeps mate distance through negation', () => {
    const cp = encodeScore(-4, null);
    const flipped = -cp;
    expect(MATE_BASE - Math.abs(flipped)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// classifyMove fixtures
// ---------------------------------------------------------------------------

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_1E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const AFTER_1E4E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
const AFTER_QH5 = 'rnb1kbnr/pppp1ppp/8/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 1 2';
const AFTER_QH5NC6 = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 2 3';
// position after 3.Qxf7+ (queen on f7, black king may capture it)
const AFTER_QXF7 = 'r1bqkbnr/pppp1Qpp/2n5/4p3/4P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 3';

const base = { minCpl: 50, ply: 10 };

describe('classifyMove', () => {
  it('does NOT flag an even trade as a hung piece', () => {
    // Ruy Lopez: 4.Bxc6 wins the knight (+300), 4...dxc6 recaptures the bishop
    // (+300) — a clean even trade nets 0 and must not be flagged.
    const fenBefore = 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4';
    const fenAfter = 'r1bqkbnr/1ppp1ppp/2B5/4p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4';
    const res = classifyMove({
      ...base,
      fenBefore,
      fenAfter,
      evalBefore: 50,
      evalAfterPlayer: 0,
      playedUci: 'b5c6',
      bestUci: 'd2d4',
      opponentBestUci: 'd7c6',
    });
    expect(res.category).not.toBe('hung-piece');
  });

  it('flags a losing capture as a hung piece (won a pawn, lost a knight)', () => {
    // 3.Nxe5?? takes the e5 pawn (+100) but it was defended by the c6 knight,
    // which recaptures (+300) — net −200 → hung.
    const fenBefore = 'r1bqkbnr/pppp1ppp/2n5/4p3/8/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    const fenAfter = 'r1bqkbnr/pppp1ppp/2n5/4N3/8/8/PPPP1PPP/RNBQKB1R b KQkq - 0 3';
    const res = classifyMove({
      ...base,
      fenBefore,
      fenAfter,
      evalBefore: 30,
      evalAfterPlayer: -250,
      playedUci: 'f3e5',
      bestUci: 'b1c3',
      opponentBestUci: 'c6e5',
    });
    expect(res.category).toBe('hung-piece');
    expect(res.hungPiece).toBe('knight');
  });

  it('attaches a reason and confidence to every label', () => {
    const res = classifyMove({
      ...base,
      fenBefore: AFTER_QH5NC6,
      fenAfter: AFTER_QXF7,
      evalBefore: 100,
      evalAfterPlayer: -850,
      playedUci: 'h5f7',
      bestUci: 'f1c4',
      opponentBestUci: 'e8f7',
    });
    expect(res.category).toBe('hung-piece');
    expect(res.reason).toContain('captures your queen');
    expect(res.confidence).toBe('high');
  });

  it('flags a hung queen when the opponent can simply capture it', () => {
    const res = classifyMove({
      ...base,
      fenBefore: AFTER_QH5NC6,
      fenAfter: AFTER_QXF7,
      evalBefore: 100,
      evalAfterPlayer: -850,
      playedUci: 'h5f7',
      bestUci: 'f1c4',
      opponentBestUci: 'e8f7',
    });
    expect(res.category).toBe('hung-piece');
    expect(res.hungPiece).toBe('queen');
  });

  it('flags allowed mate for the fools-mate pattern', () => {
    // 1. f3 e5 2. g4?? Qh4#
    const fenBefore = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2';
    const fenAfter = 'rnbqkbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
    const res = classifyMove({
      ...base,
      fenBefore,
      fenAfter,
      evalBefore: 30,
      evalAfterPlayer: -(MATE_BASE - 1),
      playedUci: 'g2g4',
      bestUci: 'b1c3',
      opponentBestUci: 'd8h4',
    });
    expect(res.category).toBe('allowed-mate');
  });

  it('prefers the best line’s own pv reply for missed-tactic detection', () => {
    // White can capture a free rook with the king (Kxb1). The best line gains
    // +500; an alternative move gains nothing. Even if the caller hands us a
    // misleading opponentBestUci (a non-capture check), the verdict holds.
    const fenBefore = 'k7/8/8/8/8/8/8/1rK5 w - - 0 1';
    const fenAfter = 'k7/8/8/8/8/8/2K5/1r6 b - - 1 1';
    const res = classifyMove({
      ...base,
      fenBefore,
      fenAfter,
      evalBefore: 500,
      evalAfterPlayer: 0,
      playedUci: 'c1c2',
      bestUci: 'c1b1',
      bestPvReply: 'a8b8',
      opponentBestUci: 'b1b2',
    });
    expect(res.category).toBe('missed-tactic');
  });

  it('classifies a silent eval drop as a positional error', () => {
    const res = classifyMove({
      ...base,
      fenBefore: AFTER_1E4E5,
      fenAfter: AFTER_QH5,
      evalBefore: 30,
      evalAfterPlayer: -60,
      playedUci: 'b1c3',
      bestUci: 'g1f3',
      opponentBestUci: 'g8f6',
    });
    expect(res.category).toBe('positional');
  });

  it('flags lost winning positions', () => {
    const res = classifyMove({
      ...base,
      fenBefore: AFTER_1E4,
      fenAfter: AFTER_1E4E5,
      evalBefore: 400,
      evalAfterPlayer: 80,
      playedUci: 'd2d4',
      bestUci: 'g1f3',
      opponentBestUci: 'e5e4',
    });
    expect(res.category).toBe('lost-win');
  });

  it('ignores small drops below the threshold', () => {
    const res = classifyMove({
      ...base,
      fenBefore: START,
      fenAfter: AFTER_1E4,
      evalBefore: 30,
      evalAfterPlayer: 10,
      playedUci: 'e2e4',
      bestUci: 'e2e4',
      opponentBestUci: 'e7e5',
    });
    expect(res.category).toBeUndefined();
  });
});

describe('reclassifyAnalysis', () => {
  it('re-themes stored plies without touching non-player moves', () => {
    const a: GameAnalysis = {
      key: 'x',
      gameKey: 'x',
      engineKey: 'fake|d10|mpv3',
      schema: 1,
      depth: 10,
      mpv: 3,
      playerColor: 'w',
      accuracy: 90,
      plies: [
        {
          ply: 1,
          fenBefore: START,
          fenAfter: AFTER_1E4,
          playedSan: 'e4',
          playedUci: 'e2e4',
          evalBefore: 30,
          evalAfterPlayer: -500, // big drop → must be themed
          cpl: 530,
          best: [{ uci: 'g1f3', cp: 30 }],
        },
        {
          ply: 2,
          fenBefore: AFTER_1E4,
          fenAfter: AFTER_1E4E5,
          playedSan: 'e5',
          playedUci: 'e7e5',
          evalBefore: -30,
          evalAfterPlayer: -500, // OPPONENT move — must NOT be classified
          cpl: 470,
          best: [{ uci: 'g8f6', cp: -30 }],
        },
      ],
      mistakeCount: 2,
      createdAt: 0,
    };
    const out = reclassifyAnalysis(a, 50);
    expect(out.schema).toBe(ANALYSIS_SCHEMA);
    expect(out.plies[0].category).toBe('positional'); // drop without material swing
    expect(out.plies[1].category).toBeUndefined(); // black's move skipped
    expect(out.mistakeCount).toBe(1);
  });
});
