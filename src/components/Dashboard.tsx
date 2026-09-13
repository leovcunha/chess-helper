import { useMemo, useState } from 'react';
import { useStore } from '../store';
import type { Category, Phase } from '../types';
import { CATEGORY_META, CATEGORY_ORDER } from '../lib/classify';
import { buildTrainingQueue, posKeyOf } from '../lib/training';

const PHASES: Phase[] = ['opening', 'middlegame', 'endgame'];
const PHASE_LABEL: Record<Phase, string> = { opening: 'Opening', middlegame: 'Middlegame', endgame: 'Endgame' };

interface Stats {
  games: number;
  avgAccuracy: number;
  totalMistakes: number;
  byCategory: Map<Category, number>;
  byCategoryPhase: Map<string, number>;
  openings: { name: string; eco: string; games: number; mistakes: number; accSum: number }[];
}

function computeStats(analyses: ReturnType<typeof useStore.getState>['analyses'], dismissed?: Record<string, unknown>): Stats {
  const byCategory = new Map<Category, number>();
  const byCategoryPhase = new Map<string, number>();
  const openings = new Map<string, { name: string; eco: string; games: number; mistakes: number; accSum: number }>();
  let games = 0;
  let accSum = 0;
  for (const a of Object.values(analyses)) {
    games++;
    accSum += a.accuracy;
    for (const p of a.plies) {
      if (!p.category) continue;
      if (dismissed?.[posKeyOf(p.fenBefore)]) continue; // user rejected this label
      byCategory.set(p.category, (byCategory.get(p.category) ?? 0) + 1);
      const key = `${p.category}|${p.phase}`;
      byCategoryPhase.set(key, (byCategoryPhase.get(key) ?? 0) + 1);
    }
  }
  return {
    games,
    avgAccuracy: games > 0 ? Math.round((accSum / games) * 10) / 10 : 0,
    totalMistakes: [...byCategory.values()].reduce((s, n) => s + n, 0),
    byCategory,
    byCategoryPhase,
    openings: [...openings.values()],
  };
}

export function Dashboard() {
  const { analyses, games, startTraining, setView, dismissed, restoreLabels } = useStore();
  const [expanded, setExpanded] = useState<Category | null>(null);
  const queueInfo = useMemo(() => buildTrainingQueue(Object.values(analyses), games, undefined, undefined, undefined, undefined, dismissed), [analyses, games, dismissed]);
  const dismissedCount = Object.keys(dismissed).length;
  const hungPieces = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of Object.values(analyses)) {
      for (const p of a.plies) {
        if (p.category === 'hung-piece' && p.hungPiece) counts.set(p.hungPiece, (counts.get(p.hungPiece) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [analyses]);
  const stats = useMemo(() => {
    const s = computeStats(analyses, dismissed);
    // openings breakdown needs game records
    const openMap = new Map<string, { name: string; eco: string; games: number; mistakes: number; accSum: number }>();
    for (const a of Object.values(analyses)) {
      const g = games[a.gameKey];
      if (!g) continue;
      const name = g.opening ? `${g.opening.eco} ${g.opening.name}`.trim() : 'Unknown opening';
      const entry = openMap.get(name) ?? { name, eco: g.opening?.eco ?? '', games: 0, mistakes: 0, accSum: 0 };
      entry.games++;
      entry.accSum += a.accuracy;
      entry.mistakes += a.plies.reduce((n, p) => n + (p.category && !dismissed?.[posKeyOf(p.fenBefore)] ? 1 : 0), 0);
      openMap.set(name, entry);
    }
    s.openings = [...openMap.values()].sort((a, b) => b.mistakes - a.mistakes).slice(0, 8);
    return s;
  }, [analyses, games, dismissed]);

  if (stats.games === 0) {
    return (
      <div className="view">
        <div className="card empty-state">
          <h2>No analysis yet</h2>
          <p className="muted">Import games and run the analyzer first — then your mistake map shows up here.</p>
          <button className="primary" onClick={() => setView('import')}>
            Go to import
          </button>
        </div>
      </div>
    );
  }

  const maxCount = Math.max(1, ...[...stats.byCategory.values()]);
  // most common first — same ordering the training queue uses
  const orderedCats = CATEGORY_ORDER.filter(c => (stats.byCategory.get(c) ?? 0) > 0).sort(
    (a, b) => (stats.byCategory.get(b) ?? 0) - (stats.byCategory.get(a) ?? 0)
  );

  return (
    <div className="view">
      <div className="stat-row">
        <div className="stat">
          <div className="stat-value">{stats.games}</div>
          <div className="stat-label">games analyzed</div>
        </div>
        <div className="stat">
          <div className="stat-value">{stats.avgAccuracy}%</div>
          <div className="stat-label">avg accuracy</div>
        </div>
        <div className="stat">
          <div className="stat-value">{stats.totalMistakes}</div>
          <div className="stat-label">mistakes mapped</div>
        </div>
      </div>

      <section className="card">
        <div className="row between">
          <h2>Your most common mistakes</h2>
        </div>
        <p className="muted">Sorted most-common first. Click a mistake type to see where (which phase) it happens.</p>
        {dismissedCount > 0 && (
          <div className="alert info small">
            {dismissedCount} label{dismissedCount === 1 ? '' : 's'} you marked as "not a mistake" are hidden from this map
            and the training queue.{' '}
            <button className="small-btn" onClick={() => void restoreLabels()}>
              Restore them
            </button>
          </div>
        )}
        <div className="mistake-list">
          {orderedCats.map((cat, rank) => {
            const meta = CATEGORY_META[cat];
            const count = stats.byCategory.get(cat) ?? 0;
            const isOpen = expanded === cat;
            return (
              <div key={cat} className="mistake-group">
                <button className="mistake-row" onClick={() => setExpanded(isOpen ? null : cat)} title={meta.description}>
                  <span className="rank">#{rank + 1}</span>
                  <span className="icon">{meta.icon}</span>
                  <span className="mistake-label" style={{ color: meta.color }}>
                    {meta.label}
                  </span>
                  <div className="bar">
                    <div className="bar-fill" style={{ width: `${(count / maxCount) * 100}%`, backgroundColor: meta.color }} />
                  </div>
                  <span className="count">{count}</span>
                  <span className="chev">{isOpen ? '▾' : '▸'}</span>
                </button>
                {isOpen && cat === 'hung-piece' ? (
                  <div className="phase-rows">
                    {hungPieces.map(([piece, n]) => (
                      <div key={piece} className="phase-row">
                        <span className="phase-name">{piece}</span>
                        <span className="count">{n}</span>
                        <button
                          className="small-btn"
                          onClick={() => startTraining([cat], undefined, piece)}
                          title={`Train every time you hung a ${piece}`}
                        >
                          Train these {n} →
                        </button>
                      </div>
                    ))}
                    <div className="phase-row">
                      <span className="phase-name muted">all pieces</span>
                      <span className="count">{count}</span>
                      <button className="small-btn" onClick={() => startTraining([cat])}>
                        Train all {count} →
                      </button>
                    </div>
                  </div>
                ) : isOpen && (
                  <div className="phase-rows">
                    {PHASES.map(phase => {
                      const n = stats.byCategoryPhase.get(`${cat}|${phase}`) ?? 0;
                      if (n === 0) return null;
                      return (
                        <div key={phase} className="phase-row">
                          <span className="phase-name">{PHASE_LABEL[phase]}</span>
                          <span className="count">{n}</span>
                          <button
                            className="small-btn"
                            onClick={() => startTraining([cat], phase)}
                            title={`Train this pattern: ${meta.label} in the ${phase}`}
                          >
                            Train these {n} →
                          </button>
                        </div>
                      );
                    })}
                    <div className="phase-row">
                      <span className="phase-name muted">all phases</span>
                      <span className="count">{count}</span>
                      <button className="small-btn" onClick={() => startTraining([cat])}>
                        Train all {count} →
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="row gap" style={{ marginTop: 16 }}>
          <button
            className="primary big"
            onClick={() => startTraining()}
            disabled={queueInfo.items.length === 0}
            title="Train every mapped mistake position, most common pattern first"
          >
            ▶ Start training session ({queueInfo.items.length} positions)
          </button>
        </div>
      </section>

      {stats.openings.length > 0 && (
        <section className="card">
          <h2>Where it hurts: openings</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Opening</th>
                <th>Games</th>
                <th>Accuracy</th>
                <th>Mistakes</th>
              </tr>
            </thead>
            <tbody>
              {stats.openings.map(o => (
                <tr key={o.name}>
                  <td>{o.name}</td>
                  <td>{o.games}</td>
                  <td>{Math.round((o.accSum / o.games) * 10) / 10}%</td>                  <td>{o.mistakes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
