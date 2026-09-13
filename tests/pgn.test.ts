import { describe, expect, it } from 'vitest';
import { splitPgn, parseHeaders, parseMovetext, buildGameRecord, timeClassFromSeconds, baseTimeSeconds } from '../src/lib/pgn';
import { parsePgnImports, pgnHash, trustedGameUrl } from '../src/lib/fetchers';

const GAME_A = `[Event "A"]
[Site "https://lichess.org/abc12"]
[Date "2026.01.01"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]
[TimeControl "300+2"]
[ECO "B01"]
[Opening "Scandinavian"]

1. e4 {[%clk 0:04:55]} d5 2. exd5 Qxd5 1-0`;

const GAME_B = `[Event "B"]
[Site "https://www.chess.com/game/live/987654"]
[Date "2026.02.02"]
[White "Bob"]
[Black "Alice"]
[Result "0-1"]
[TimeControl "600"]
[ECO "C20"]

1. e4 e5 2. Nf3 Nc6 0-1`;

describe('pgn parsing', () => {
  it('splits concatenated PGNs on game boundaries', () => {
    const games = splitPgn(`${GAME_A}\n\n${GAME_B}`);
    expect(games).toHaveLength(2);
    expect(games[0]).toContain('[Event "A"]');
    expect(games[1]).toContain('[Event "B"]');
  });

  it('handles CRLF line endings', () => {
    const games = splitPgn(GAME_A.replace(/\n/g, '\r\n'));
    expect(games).toHaveLength(1);
  });

  it('parses headers', () => {
    const h = parseHeaders(GAME_A);
    expect(h.White).toBe('Alice');
    expect(h.Black).toBe('Bob');
    expect(h.TimeControl).toBe('300+2');
    expect(h.ECO).toBe('B01');
  });

  it('strips comments, variations, NAGs and move numbers from movetext', () => {
    const sans = parseMovetext('1. e4 {great} d5 (1... e5 2. Nf3) 2. exd5 $14 Qxd5 *');
    expect(sans).toEqual(['e4', 'd5', 'exd5', 'Qxd5']);
  });

  it('classifies time controls', () => {
    expect(timeClassFromSeconds(baseTimeSeconds('60+0'))).toBe('bullet');
    expect(timeClassFromSeconds(baseTimeSeconds('300+2'))).toBe('blitz');
    expect(timeClassFromSeconds(baseTimeSeconds('600'))).toBe('rapid');
    expect(timeClassFromSeconds(baseTimeSeconds('1800+30'))).toBe('classical');
  });

  it('builds a record with the right player color and result', () => {
    const rec = buildGameRecord({ site: 'lichess', id: 'abc12', url: 'https://lichess.org/abc12', pgn: GAME_A, username: 'bob' });
    expect(rec.playerColor).toBe('b');
    expect(rec.playerResult).toBe('loss');
    expect(rec.timeClass).toBe('blitz');
    expect(rec.opening?.name).toBe('Scandinavian');
    const rec2 = buildGameRecord({ site: 'chesscom', id: '987654', url: 'https://www.chess.com/game/live/987654', pgn: GAME_B, username: 'bob' });
    expect(rec2.playerColor).toBe('w');
    expect(rec2.playerResult).toBe('loss'); // Bob is White in a 0-1 game
  });

  it('throws on PGNs without moves', () => {
    expect(() => buildGameRecord({ site: 'lichess', id: 'x', url: '', pgn: '[Event "x"]\n[White "a"]\n[Black "b"]\n*', username: 'a' })).toThrow();
  });
});

describe('pgn import trust', () => {
  it('detects colors from the requested username and reports dedupe/invalid counts', () => {
    const preview = parsePgnImports(`${GAME_A}\n\n${GAME_B}\n\n${GAME_A}`, 'alice');
    expect(preview.records).toHaveLength(2); // third game is a duplicate in-batch
    expect(preview.duplicatesInBatch).toBe(1);
    expect(preview.invalid).toBe(0);
    expect(preview.records[0].playerColor).toBe('w'); // Alice is White in game A
    expect(preview.records[0].playerResult).toBe('win');
    expect(preview.records[1].playerColor).toBe('b');
  });

  it('generates stable ids for games without a trusted site URL', () => {
    const custom = '[Event "Z"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. d4 d5 2. c4 1-0';
    const run1 = parsePgnImports(custom, 'a');
    const run2 = parsePgnImports(custom, 'a');
    expect(run1.records[0].key).toBe(run2.records[0].key); // same content → same id
    const other = custom.replace('1. d4 d5 2. c4', '1. e4 e5 2. Nf3');
    expect(parsePgnImports(other, 'a').records[0].key).not.toBe(run1.records[0].key);
  });

  it('defaults to White when no username is given (and says so via color)', () => {
    const preview = parsePgnImports(GAME_A, '');
    expect(preview.records[0].playerColor).toBe('w');
  });

  it('hashes content stably and differently for different content', () => {
    expect(pgnHash('abc')).toBe(pgnHash('abc'));
    expect(pgnHash('abc')).not.toBe(pgnHash('abd'));
  });

  it('only trusts real site hostnames', () => {
    expect(trustedGameUrl('https://lichess.org/abc12')).toBe('https://lichess.org/abc12');
    expect(trustedGameUrl('https://evil.com/?x=lichess.org')).toBe('');
    expect(trustedGameUrl('http://fake-chess.com/game/1')).toBe('');
    expect(trustedGameUrl('https://chess.com/game/live/1')).toContain('chess.com');
    expect(trustedGameUrl('not a url')).toBe('');
  });
});
