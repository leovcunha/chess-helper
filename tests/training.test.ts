import { describe, expect, it } from 'vitest';
import { buildTrainingQueue, posKeyOf } from '../src/lib/training';
import type { GameAnalysis, GameRecord, TrainingStats } from '../src/types';

function game(key: string, opening?: string): GameRecord {
  return {
    key,
    site: 'lichess',
    id: key,
    url: '',
    pgn: '',
    white: 'you',
    black: 'them',
    playerColor: 'w',
    playerResult: 'win',
    timeClass: 'blitz',
    rated: true,
    opening: opening ? { eco: 'A00', name: opening } : undefined,
  };
}

function mistakePly(fen: string, category: GameAnalysis['plies'][number]['category'], cpl: number, san = 'Qxf7?') {
  return {
    ply: 9,
    fenBefore: fen,
    fenAfter: fen,
    playedSan: san,
    playedUci: 'd1f3',
    evalBefore: 0,
    evalAfterPlayer: -cpl,
    cpl,
    best: [{ uci: 'd1e2', cp: 0 }],
    category,
    phase: 'middlegame' as const,
  };
}

const FEN_1 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FEN_2 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const FEN_3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

function analysis(key: string, plies: ReturnType<typeof mistakePly>[]): GameAnalysis {
  return {
    key: `${key}|fake`,
    gameKey: key,
    engineKey: 'fake',
    schema: 3,
    depth: 10,
    mpv: 3,
    playerColor: 'w',
    accuracy: 90,
    plies,
    mistakeCount: plies.length,
    createdAt: 0,
  };
}

describe('buildTrainingQueue', () => {
  it('orders categories by frequency, most common first', () => {
    const analyses = [
      analysis('g1', [mistakePly(FEN_1, 'positional', 60), mistakePly(FEN_2, 'positional', 70)]),
      analysis('g2', [mistakePly(FEN_3, 'hung-piece', 300)]),
    ];
    const { categories, items } = buildTrainingQueue(analyses, {});
    expect(categories[0]).toEqual({ key: 'positional', count: 2 });
    expect(categories[1]).toEqual({ key: 'hung-piece', count: 1 });
    expect(items[0].category).toBe('positional');
    expect(items[2].category).toBe('hung-piece');
  });

  it('dedupes positions across games keeping the worst loss', () => {
    const analyses = [
      analysis('g1', [mistakePly(FEN_1, 'positional', 60)]),
      analysis('g2', [mistakePly(FEN_1, 'positional', 250)]),
    ];
    const { items } = buildTrainingQueue(analyses, {});
    expect(items).toHaveLength(1);
    expect(items[0].cpl).toBe(250);
  });

  it('sorts within a category by severity', () => {
    const analyses = [analysis('g1', [mistakePly(FEN_1, 'positional', 60), mistakePly(FEN_2, 'positional', 300), mistakePly(FEN_3, 'positional', 90)])];
    const { items } = buildTrainingQueue(analyses, {});
    expect(items.map(i => i.cpl)).toEqual([300, 90, 60]);
  });

  it('surfaces due (recently wrong) positions and buries mastered ones', () => {
    const now = Date.now();
    const stats: Record<string, TrainingStats> = {
      [posKeyOf(FEN_1)]: { attempts: 2, correct: 2, lastResult: 'correct', lastAt: now - 1000 }, // mastered
      [posKeyOf(FEN_2)]: { attempts: 1, correct: 0, lastResult: 'wrong', lastAt: now - 1000 }, // due
      [posKeyOf(FEN_3)]: { attempts: 1, correct: 1, lastResult: 'correct', lastAt: now - 1000 }, // fresh solve
    };
    const analyses = [
      analysis('g1', [
        mistakePly(FEN_1, 'positional', 500),
        mistakePly(FEN_2, 'positional', 400),
        mistakePly(FEN_3, 'positional', 300),
      ]),
    ];
    const { items } = buildTrainingQueue(analyses, {}, undefined, undefined, stats);
    expect(items.map(i => posKeyOf(i.fen))).toEqual([posKeyOf(FEN_2), posKeyOf(FEN_3), posKeyOf(FEN_1)]);
  });

  it('respects the hung-piece filter and user dismissals', () => {
    const analyses = [
      analysis('g1', [
        { ...mistakePly(FEN_1, 'hung-piece', 300), hungPiece: 'rook' },
        mistakePly(FEN_2, 'positional', 90),
        { ...mistakePly(FEN_3, 'hung-piece', 250), hungPiece: 'queen' },
      ]),
    ];
    const dismissed = { [posKeyOf(FEN_1)]: { label: 'hung-piece', at: 1 } };
    const byPiece = buildTrainingQueue(analyses, {}, undefined, undefined, undefined, 'pawn');
    expect(byPiece.items).toHaveLength(0); // none of the hangs are pawns in this fixture
    const rookOnly = buildTrainingQueue(analyses, {}, ['hung-piece'], undefined, undefined, 'rook');
    expect(rookOnly.items).toHaveLength(1);
    const withoutDismissed = buildTrainingQueue(analyses, {}, undefined, undefined, undefined, undefined, dismissed);
    expect(withoutDismissed.items).toHaveLength(2);
    expect(withoutDismissed.categories.find(c => c.key === 'hung-piece')?.count).toBe(1);
  });

  it('respects category and phase filters', () => {
    const analyses = [
      analysis('g1', [
        { ...mistakePly(FEN_1, 'positional', 60), phase: 'opening' as const },
        mistakePly(FEN_2, 'hung-piece', 300),
      ]),
    ];
    expect(buildTrainingQueue(analyses, {}, ['hung-piece']).items).toHaveLength(1);
    expect(buildTrainingQueue(analyses, {}, undefined, 'opening').items).toHaveLength(1);
    expect(buildTrainingQueue(analyses, {}, undefined, 'opening').items[0].category).toBe('positional');
  });
});
