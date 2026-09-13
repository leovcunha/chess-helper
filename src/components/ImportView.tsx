import { useRef, useState } from 'react';
import { useStore } from '../store';
import type { GameRecord, TimeClass } from '../types';
import { fetchChesscom, fetchLichess, parsePgnImports } from '../lib/fetchers';

const TIME_CLASSES: TimeClass[] = ['bullet', 'blitz', 'rapid', 'classical'];

const DEPTH_PRESETS = [
  { label: 'Fast', depth: 10, hint: 'quicker, noisier evals' },
  { label: 'Balanced', depth: 13, hint: 'recommended' },
  { label: 'Deep', depth: 16, hint: 'slow but sharp' },
];

interface PendingImport {
  records: GameRecord[];
  duplicatesInBatch: number;
  invalid: number;
}

export function ImportView() {
  const { filters, setFilters, importState, setImportState, addGames, games, job, startAnalysis, cancelAnalysis, settings, setSettings, ensureEngine } =
    useStore();
  const [pgnOpen, setPgnOpen] = useState(false);
  const [pgnText, setPgnText] = useState('');
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [reanalyze, setReanalyze] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const gameCount = Object.keys(games).length;

  const toggleTimeClass = (tc: TimeClass) => {
    const has = filters.timeClasses.includes(tc);
    const next = has ? filters.timeClasses.filter(t => t !== tc) : [...filters.timeClasses, tc];
    setFilters({ timeClasses: next });
  };

  const doFetch = async () => {
    setImportState({ active: true, message: 'Starting…', error: null });
    const all: GameRecord[] = [];
    try {
      if (filters.lichessUser.trim()) {
        const got = await fetchLichess(filters.lichessUser.trim(), filters, p => setImportState({ message: p.message }));
        all.push(...got);
      }
      if (filters.chesscomUser.trim()) {
        const got = await fetchChesscom(filters.chesscomUser.trim(), filters, p => setImportState({ message: p.message }));
        all.push(...got);
      }
      if (all.length === 0) {
        setImportState({
          active: false,
          message: '',
          error: 'No games matched. Check the username(s), or relax the time-control / rated filters.',
        });
        return;
      }
      const added = await addGames(all);
      setImportState({
        active: false,
        message: `Fetched ${all.length} games (${added} new). ${gameCount + added} games stored.`,
        error: null,
      });
    } catch (e) {
      setImportState({ active: false, message: '', error: e instanceof Error ? e.message : String(e) });
    }
  };

  const doImportPgn = async (records: GameRecord[]) => {
    setImportState({ active: true, message: 'Saving…', error: null });
    const added = await addGames(records);
    setPgnText('');
    setPending(null);
    const dupStored = records.length - added;
    setImportState({
      active: false,
      message: `Imported ${added} new game${added === 1 ? '' : 's'}${dupStored ? ` (${dupStored} already stored, refreshed)` : ''}.`,
      error: null,
    });
  };

  const parseForPreview = () => {
    setImportState({ active: true, message: 'Parsing…', error: null });
    const preview = parsePgnImports(pgnText, filters.pgnUsername, p => setImportState({ message: p.message }));
    if (preview.records.length === 0) {
      setImportState({ active: false, message: '', error: `No valid games found (${preview.invalid} unparseable). Check the PGN.` });
      return;
    }
    setImportState({ active: false, message: '', error: null });
    setPending(preview);
  };

  const onFile = async (f: File) => {
    const text = await f.text();
    setPgnText(text);
    setPgnOpen(true);
  };

  const progressPct = (() => {
    const p = job.progress;
    if (!p) return 0;
    if (p.pliesTotal > 0) return Math.min(100, Math.round((p.ply / p.pliesTotal) * 100));
    return 0;
  })();

  return (
    <div className="view">
      <section className="card">
        <h2>1 · Import your games</h2>
        <p className="muted">
          Both sites' public APIs are fetched directly from your browser — no account login needed, only public games.
        </p>
        <div className="grid-2" title="Each site has its own limit; fetching stops as soon as the limit is reached">
          <div className="field-group">
            <h3>Lichess</h3>
            <label className="label">Username</label>
            <input
              placeholder="e.g. DrNykterStein"
              value={filters.lichessUser}
              onChange={e => setFilters({ lichessUser: e.target.value })}
            />
            <label className="label">Fetch up to {filters.lichessMax} games (Lichess only)</label>
            <input
              type="range"
              min={5}
              max={150}
              step={5}
              value={filters.lichessMax}
              onChange={e => setFilters({ lichessMax: Number(e.target.value) })}
            />
          </div>
          <div className="field-group">
            <h3>Chess.com</h3>
            <label className="label">Username</label>
            <input
              placeholder="e.g. hikaru"
              value={filters.chesscomUser}
              onChange={e => setFilters({ chesscomUser: e.target.value })}
            />
            <label className="label">Months of archives: {filters.chesscomMonths}</label>
            <input
              type="range"
              min={1}
              max={24}
              value={filters.chesscomMonths}
              onChange={e => setFilters({ chesscomMonths: Number(e.target.value) })}
            />
            <label className="label">Fetch up to {filters.chesscomMax} games (Chess.com only)</label>
            <input
              type="range"
              min={10}
              max={400}
              step={10}
              value={filters.chesscomMax}
              onChange={e => setFilters({ chesscomMax: Number(e.target.value) })}
            />
          </div>
        </div>
        <div className="row wrap gap">
          <span className="label">Time controls:</span>
          {TIME_CLASSES.map(tc => (
            <button
              key={tc}
              className={`chip ${filters.timeClasses.includes(tc) ? 'chip-on' : ''}`}
              onClick={() => toggleTimeClass(tc)}
            >
              {tc}
            </button>
          ))}
          <button className={`chip ${filters.ratedOnly ? 'chip-on' : ''}`} onClick={() => setFilters({ ratedOnly: !filters.ratedOnly })}>
            rated only
          </button>
        </div>
        <div className="row gap">
          <button className="primary" onClick={doFetch} disabled={importState.active}>
            {importState.active ? 'Fetching…' : 'Fetch games'}
          </button>
          <button onClick={() => setPgnOpen(o => !o)}>{pgnOpen ? 'Hide PGN import' : '…or paste PGN'}</button>
          <input
            ref={fileRef}
            type="file"
            accept=".pgn,.txt"
            style={{ display: 'none' }}
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          <button onClick={() => fileRef.current?.click()}>Upload .pgn file</button>
        </div>
        {pgnOpen && (
          <div>
            <label className="label">
              Your username in these games — so the trainer drills <b>your</b> mistakes, not your opponent's
            </label>
            <input
              placeholder="e.g. hikaru (must match the name in the PGN)"
              value={filters.pgnUsername}
              onChange={e => setFilters({ pgnUsername: e.target.value })}
            />
            <textarea
              className="pgn-box"
              rows={6}
              placeholder="Paste one or more PGN games here (from Lichess, Chess.com, or anywhere)"
              value={pgnText}
              onChange={e => setPgnText(e.target.value)}
            />
            <button className="primary" onClick={parseForPreview} disabled={!pgnText.trim() || importState.active}>
              Preview PGN
            </button>
          </div>
        )}
        {pending && (
          <div className="alert ok">
            <div className="feedback-title">
              {pending.records.length} game{pending.records.length === 1 ? '' : 's'} ready to import
              {pending.duplicatesInBatch ? ` · ${pending.duplicatesInBatch} duplicates in file skipped` : ''}
              {pending.invalid ? ` · ${pending.invalid} invalid skipped` : ''}
            </div>
            {!filters.pgnUsername.trim() && (
              <div className="small" style={{ margin: '6px 0' }}>
                ⚠️ No username given — these games will count as White's. Fill in "Your username" and re-parse to fix.
              </div>
            )}
            <table className="table">
              <thead>
                <tr>
                  <th>White</th>
                  <th>Black</th>
                  <th>You play</th>
                  <th>Date</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pending.records.slice(0, 20).map(r => {
                  const stored = !!games[r.key];
                  return (
                    <tr key={r.key}>
                      <td>{r.white}</td>
                      <td>{r.black}</td>
                      <td className={r.playerColor === 'w' ? 'good' : ''}>{r.playerColor === 'w' ? 'White' : 'Black'}</td>
                      <td className="muted">{r.playedAt ?? '—'}</td>
                      <td>{stored ? 'already stored' : 'new'}</td>
                    </tr>
                  );
                })}
                {pending.records.length > 20 && (
                  <tr>
                    <td colSpan={5} className="muted small">
                      … and {pending.records.length - 20} more
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="row gap" style={{ marginTop: 10 }}>
              <button className="primary" onClick={() => void doImportPgn(pending.records)}>
                Import {pending.records.length} game{pending.records.length === 1 ? '' : 's'}
              </button>
              <button onClick={() => setPending(null)}>Cancel</button>
            </div>
          </div>
        )}
        {(importState.message || importState.error) && (
          <div className={importState.error ? 'alert error' : 'alert ok'}>
            {importState.error ?? importState.message}
          </div>
        )}
      </section>

      <section className="card">
        <h2>2 · Analyze with Stockfish</h2>
        <p className="muted">
          Every position of every stored game is evaluated to find blunders, hung material, missed mates and tactics.
          It runs locally in your browser — expect roughly a minute or two per game depending on depth and game length.
        </p>
        <div className="row wrap gap">
          {DEPTH_PRESETS.map(p => (
            <button
              key={p.label}
              className={`chip ${settings.depth === p.depth ? 'chip-on' : ''}`}
              onClick={() => setSettings({ depth: p.depth })}
              title={p.hint}
            >
              {p.label} (depth {p.depth})
            </button>
          ))}
        </div>
        <label className="row gap" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={reanalyze} onChange={e => setReanalyze(e.target.checked)} />
          Re-analyze games that were already analyzed
        </label>
        <p className="muted small" style={{ marginTop: 4 }}>
          Games with an up-to-date analysis (same depth) are skipped unless you tick re-analyze.
        </p>
        <div className="row gap">
          <button
            className="primary"
            disabled={gameCount === 0 || job.active}
            onClick={() => {
              void ensureEngine();
              void startAnalysis(Object.keys(games), reanalyze);
            }}
          >
            {job.active ? 'Analyzing…' : `Analyze ${gameCount} stored game${gameCount === 1 ? '' : 's'}`}
          </button>
          {job.active && (
            <button className="danger" onClick={cancelAnalysis}>
              Cancel
            </button>
          )}
        </div>
        {job.active && job.progress && (
          <div className="progress-wrap">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="muted small">
              {job.progress.phase === 'loading-engine'
                ? `${job.progress.gameLabel} — warming up…`
                : `${job.progress.gameLabel} · positions ${job.progress.ply}/${job.progress.pliesTotal} · games done ${job.progress.gamesDone}/${job.progress.gamesTotal}`}
            </div>
          </div>
        )}
        {job.error && <div className="alert error">{job.error}</div>}
        {job.result && !job.active && (
          <div className="alert ok">
            <div>
              Analyzed <b>{job.result.analyzed}</b> game{job.result.analyzed === 1 ? '' : 's'}
              {job.result.partial ? `, ${job.result.partial} partial (some positions failed — re-analyze to retry)` : ''}
              {job.result.failed ? `, ${job.result.failed} failed` : ''}
              {job.result.skipped ? ` · ${job.result.skipped} skipped (already analyzed at this depth)` : ''}
              {job.result.cancelled ? ' (cancelled)' : ''}.
            </div>
            {job.result.failures.length > 0 && (
              <div className="small" style={{ marginTop: 6 }}>
                {job.result.failures.slice(0, 3).map(f => (
                  <div key={f.game}>
                    ⚠️ {f.game}: {f.reason}
                  </div>
                ))}
                {job.result.failures.length > 3 && <div>… and {job.result.failures.length - 3} more</div>}
              </div>
            )}
            <div className="small" style={{ marginTop: 6 }}>
              Open the <b>Mistake Map</b> to see your patterns.
            </div>
          </div>
        )}
        {gameCount > 0 && (
          <p className="muted small" style={{ marginTop: 8 }}>
            {gameCount} games stored locally. Games and analysis are cached in your browser (IndexedDB) — refreshing won't
            lose them.
          </p>
        )}
      </section>
    </div>
  );
}
