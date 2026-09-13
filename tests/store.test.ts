import { describe, expect, it } from 'vitest';
import { normalizeFilters, normalizeSettings } from '../src/store';

describe('persisted-shape normalization', () => {
  it('fills missing chesscomMax/pgnUsername from old filters (prevents NaN caps)', () => {
    const old: Record<string, unknown> = {
      lichessUser: 'me',
      lichessMax: 30,
      chesscomUser: 'me',
      chesscomMonths: 6,
      timeClasses: ['blitz'],
      ratedOnly: true,
      // no chesscomMax, no pgnUsername — the pre-v2 persisted shape
    };
    const f = normalizeFilters(old as unknown as Parameters<typeof normalizeFilters>[0]);
    expect(f.chesscomMax).toBe(30); // 100 was the accidental v1 default → migrated
    expect(f.pgnUsername).toBe('');
    expect(f.lichessMax).toBe(30);
    expect(f.chesscomMonths).toBe(6);
  });

  it('keeps valid values and repairs garbage ones', () => {
    const f = normalizeFilters({
      lichessMax: NaN,
      chesscomMax: 250,
      chesscomMonths: NaN,
    } as unknown as Parameters<typeof normalizeFilters>[0]);
    expect(f.lichessMax).toBe(30);
    expect(f.chesscomMax).toBe(250);
    expect(f.chesscomMonths).toBe(6);
    // a deliberately chosen 250 survives; only the inherited 100 migrates
    const kept = normalizeFilters({ chesscomMax: 100 } as unknown as Parameters<typeof normalizeFilters>[0]);
    expect(kept.chesscomMax).toBe(30);
  });

  it('normalizes old threshold shapes', () => {
    const s = normalizeSettings({ depth: 13, mpv: 3, thresholds: { inaccuracy: 75, mistake: 150, blunder: 400 } } as unknown as Parameters<typeof normalizeSettings>[0]);
    expect(s.thresholds.minCpl).toBe(75);
  });
});
