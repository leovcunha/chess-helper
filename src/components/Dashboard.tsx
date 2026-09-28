import { useMemo, useState } from 'react';
import { useStore } from '../store';
import type { Category, Phase, TrainingStats } from '../types';
import { CATEGORY_META, CATEGORY_ORDER } from '../lib/classify';
import { buildChartGeometry, computeProgressReport } from '../lib/progress';
import { buildTrainingQueue, posKeyOf } from '../lib/training';

const PHASES: Phase[] = ['opening', 'middlegame', 'endgame'];
const PHASE_LABEL: Record<Phase, string> = { opening: 'Opening', middlegame: 'Middlegame', endgame: 'Endgame' };
const positions = (n: number) => `${n} position${n === 1 ? '' : 's'}`;

interface Stats {
  games: number;
  avgAccuracy: number;
  totalMistakes: number;
  totalTrained: number;
  byCategory: Map<Category, number>;
  byCategoryTrained: Map<Category, number>;
  byCategoryPhase: Map<string, number>;
  byCategoryPhaseTrained: Map<string, number>;
  openings: { name: string; eco: string; games: number; mistakes: number; accSum: number }[];
}

function computeStats(
  analyses: ReturnType<typeof useStore.getState>['analyses'],
  trainingStats?: Record<string, TrainingStats>,
  dismissed?: Record<string, unknown>
): Stats {
  const byCategory = new Map<Category, number>();
  const byCategoryTrained = new Map<Category, number>();
  const byCategoryPhase = new Map<string, number>();
  const byCategoryPhaseTrained = new Map<string, number>();
  const openings = new Map<string, { name: string; eco: string; games: number; mistakes: number; accSum: number }>();
  let games = 0;
  let accSum = 0;
  let totalTrained = 0;
  for (const a of Object.values(analyses)) {
    games++;
    accSum += a.accuracy;
    for (const p of a.plies) {
      if (!p.category) continue;
      const key = posKeyOf(p.fenBefore);
      if (dismissed?.[key]) continue; // user rejected this label
      const isTrained = (trainingStats?.[key]?.attempts ?? 0) > 0;
      if (isTrained) totalTrained++;
      byCategory.set(p.category, (byCategory.get(p.category) ?? 0) + 1);
      if (isTrained) {
        byCategoryTrained.set(p.category, (byCategoryTrained.get(p.category) ?? 0) + 1);
      }
      const catPhaseKey = `${p.category}|${p.phase}`;
      byCategoryPhase.set(catPhaseKey, (byCategoryPhase.get(catPhaseKey) ?? 0) + 1);
      if (isTrained) {
        byCategoryPhaseTrained.set(catPhaseKey, (byCategoryPhaseTrained.get(catPhaseKey) ?? 0) + 1);
      }
    }
  }
  return {
    games,
    avgAccuracy: games > 0 ? Math.round((accSum / games) * 10) / 10 : 0,
    totalMistakes: [...byCategory.values()].reduce((s, n) => s + n, 0),
    totalTrained,
    byCategory,
    byCategoryTrained,
    byCategoryPhase,
    byCategoryPhaseTrained,
    openings: [...openings.values()],
  };
}

export function Dashboard() {
  const { analyses, games, startTraining, setView, dismissed, restoreLabels, trainingStats } = useStore();
  const [expanded, setExpanded] = useState<Category | null>(null);
  const queueInfo = useMemo(() => buildTrainingQueue(Object.values(analyses), games, undefined, undefined, trainingStats, undefined, dismissed), [analyses, games, trainingStats, dismissed]);
  const dismissedCount = Object.keys(dismissed).length;
  const hungPieces = useMemo(() => {
    const counts = new Map<string, { total: number; trained: number }>();
    for (const a of Object.values(analyses)) {
      for (const p of a.plies) {
        if (p.category === 'hung-piece' && p.hungPiece) {
          const key = posKeyOf(p.fenBefore);
          if (dismissed?.[key]) continue;
          const isTrained = (trainingStats?.[key]?.attempts ?? 0) > 0;
          const prev = counts.get(p.hungPiece) ?? { total: 0, trained: 0 };
          counts.set(p.hungPiece, {
            total: prev.total + 1,
            trained: prev.trained + (isTrained ? 1 : 0),
          });
        }
      }
    }
    return [...counts.entries()]
      .map(([piece, { total, trained }]) => ({ piece, total, trained, untrained: total - trained }))
      .sort((a, b) => b.total - a.total);
  }, [analyses, trainingStats, dismissed]);
  const stats = useMemo(() => {
    const s = computeStats(analyses, trainingStats, dismissed);
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
  }, [analyses, games, trainingStats, dismissed]);

  const progress = useMemo(
    () => computeProgressReport(analyses, games, trainingStats, dismissed),
    [analyses, games, trainingStats, dismissed]
  );
  const chart = useMemo(() => buildChartGeometry(progress.chartBuckets), [progress.chartBuckets]);

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

      <section className="card progress-card">
        <div className="row between wrap gap">
          <div>
            <h2>Weekly progress &amp; training effectiveness</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              {progress.subline}
            </p>
          </div>
          <span className={`verdict-pill verdict-${progress.verdict}`}>
            {progress.verdict === 'improving'
              ? '▲ Improving'
              : progress.verdict === 'needs-work'
                ? '▼ Recent dip'
                : progress.verdict === 'steady'
                  ? '● Steady'
                  : '◌ Building baseline'}
          </span>
        </div>

        <div className="progress-headline">{progress.headline}</div>

        <div className="progress-metrics-grid">
          <div className="progress-metric">
            <div className="progress-metric-label">Recent Accuracy</div>
            <div className="progress-metric-value">
              {progress.recentAccuracy}%
              {progress.totalGames >= 2 && (
                <span className={`delta-badge ${progress.accuracyDelta > 0 ? 'good' : progress.accuracyDelta < 0 ? 'bad' : 'muted'}`}>
                  {progress.accuracyDelta > 0 ? `+${progress.accuracyDelta}%` : `${progress.accuracyDelta}%`}
                </span>
              )}
            </div>
            <div className="progress-metric-sub muted small">Prior baseline: {progress.priorAccuracy}%</div>
          </div>

          <div className="progress-metric">
            <div className="progress-metric-label">Mistakes per 40 Moves</div>
            <div className="progress-metric-value">
              {progress.recentMistakesPer40}
              {progress.totalGames >= 2 && progress.mistakesDeltaPct !== 0 && (
                <span className={`delta-badge ${progress.mistakesDeltaPct < 0 ? 'good' : 'bad'}`}>
                  {progress.mistakesDeltaPct > 0 ? `+${progress.mistakesDeltaPct}%` : `${progress.mistakesDeltaPct}%`}
                </span>
              )}
            </div>
            <div className="progress-metric-sub muted small">
              {progress.recentMistakesPerGame} mistakes per game (was {progress.priorMistakesPerGame})
            </div>
          </div>

          <div className="progress-metric">
            <div className="progress-metric-label">Training Coverage</div>
            <div className="progress-metric-value">
              {progress.trainingCoveragePct}%
              <span className="delta-badge muted">
                {progress.trainedUniqueMistakes} of {progress.totalUniqueMistakes}
              </span>
            </div>
            <div className="progress-metric-sub muted small">
              {progress.masteryPct}% solved ({positions(progress.masteredUniqueMistakes)} mastered)
            </div>
          </div>

          <div className="progress-metric">
            <div className="progress-metric-label">
              {progress.drilledCategoryDeltaPct !== null ? 'Post-Training Theme Impact' : 'Clean Game Rate'}
            </div>
            <div className="progress-metric-value">
              {progress.drilledCategoryDeltaPct !== null ? (
                <>
                  {progress.drilledCategoryDeltaPct > 0
                    ? `+${progress.drilledCategoryDeltaPct}%`
                    : `${progress.drilledCategoryDeltaPct}%`}
                  <span className={`delta-badge ${progress.drilledCategoryDeltaPct <= 0 ? 'good' : 'bad'}`}>
                    {progress.drilledCategoryDeltaPct <= 0 ? 'fewer mistakes/game' : 'more mistakes/game'}
                  </span>
                </>
              ) : (
                <>{progress.cleanGamePct}%</>
              )}
            </div>
            <div className="progress-metric-sub muted small">
              {progress.cleanGamePct}% of games have ≤ 1 mistake
            </div>
          </div>
        </div>

        {chart.nodes.length >= 1 && (
          <div className="progress-chart-wrap">
            <div className="progress-chart-legend small muted">
              <span>
                <span className="legend-dot acc" /> Avg Accuracy (%) — by week played
              </span>
              <span>
                <span className="legend-dot err" /> Mistakes per 40 moves — by week played
              </span>
              <span>
                <span className="legend-bar" /> Exercises trained — by week trained
              </span>
            </div>
            <svg
              className="progress-chart-svg"
              viewBox={`0 0 ${chart.width} ${chart.height}`}
              role="img"
              aria-label="Weekly accuracy, mistakes, and training progression chart"
            >
              {/* Subtle horizontal grid lines */}
              {[0, 0.5, 1].map(frac => {
                const y = chart.padTop + frac * chart.plotHeight;
                return (
                  <line
                    key={frac}
                    x1={chart.padLeft}
                    y1={y}
                    x2={chart.width - chart.padRight}
                    y2={y}
                    stroke="#2c323d"
                    strokeDasharray="3 3"
                    strokeWidth="1"
                  />
                );
              })}

              {/* Trained exercises bars (by the week the user actually trained) */}
              {chart.nodes.map(n =>
                n.barH > 0 ? (
                  <g key={`bar-${n.key}`}>
                    <rect
                      x={n.barX}
                      y={n.barY}
                      width={n.barW}
                      height={n.barH}
                      rx="4"
                      fill="rgba(138, 180, 248, 0.24)"
                      stroke="rgba(138, 180, 248, 0.55)"
                      strokeWidth="1"
                    >
                      <title>{`Week of ${n.label}: ${n.trainedExercises} exercises trained`}</title>
                    </rect>
                  </g>
                ) : null
              )}

              {/* Mistakes per 40 moves line */}
              {chart.mistakePoints.includes(' ') && (
                <polyline
                  fill="none"
                  stroke="#e5484d"
                  strokeWidth="2"
                  strokeDasharray="5 3"
                  points={chart.mistakePoints}
                />
              )}

              {/* Accuracy line */}
              {chart.accuracyPoints.includes(' ') && (
                <polyline fill="none" stroke="#4ade80" strokeWidth="2.5" points={chart.accuracyPoints} />
              )}

              {/* Data points & clear axis labels */}
              {chart.nodes.map(n => (
                <g key={n.key}>
                  {n.errY !== null && n.mistakesPer40 !== null && (
                    <>
                      <circle cx={n.x} cy={n.errY} r="3.5" fill="#e5484d">
                        <title>{`Week of ${n.label}: ${n.mistakesPer40} mistakes per 40 moves (${n.mistakesPerGame} per game)`}</title>
                      </circle>
                      <text x={n.x} y={n.errLabelY ?? n.errY + 13} textAnchor="middle" className="chart-val-err">
                        {n.mistakesPer40}
                      </text>
                    </>
                  )}

                  {n.accY !== null && n.avgAccuracy !== null && (
                    <>
                      <circle cx={n.x} cy={n.accY} r="4" fill="#4ade80" stroke="#14171c" strokeWidth="1.5">
                        <title>{`Week of ${n.label} (${n.gamesCount} games): ${n.avgAccuracy}% avg accuracy`}</title>
                      </circle>
                      <text x={n.x} y={n.accLabelY ?? n.accY - 8} textAnchor="middle" className="chart-val-acc">
                        {n.avgAccuracy}%
                      </text>
                    </>
                  )}

                  <text x={n.x} y={chart.baselineY + 15} textAnchor="middle" className="chart-axis-label">
                    {n.label}
                  </text>
                  <text x={n.x} y={chart.baselineY + 28} textAnchor="middle" className="chart-axis-sub">
                    {n.gamesCount === 0
                      ? 'No games played'
                      : `${n.gamesCount} ${n.gamesCount === 1 ? 'game' : 'games'}`}
                  </text>
                  {n.trainedExercises > 0 && (
                    <text x={n.x} y={chart.baselineY + 41} textAnchor="middle" className="chart-axis-trained">
                      {n.trainedExercises} trained
                    </text>
                  )}
                </g>
              ))}
            </svg>
          </div>
        )}

        {progress.categoryEffectiveness.length > 0 && (
          <div className="effectiveness-table-wrap">
            <div className="muted small" style={{ marginBottom: 8, fontWeight: 600 }}>
              Theme-by-theme training progress &amp; impact on subsequent games
            </div>
            <div className="effectiveness-rows">
              {progress.categoryEffectiveness.map(ce => (
                <div key={ce.category} className="effectiveness-row">
                  <div className="effectiveness-header">
                    <span className="effectiveness-cat" style={{ color: ce.color }}>
                      {ce.icon} {ce.label}
                    </span>
                    {ce.status === 'improved' && (
                      <span className="impact-pill good">
                        ▼ {Math.abs(ce.deltaPct ?? 0)}% fewer mistakes/game
                      </span>
                    )}
                    {ce.status === 'regressed' && (
                      <span className="impact-pill bad">
                        ▲ +{ce.deltaPerGame} mistakes/game
                      </span>
                    )}
                    {ce.status === 'steady' && (
                      <span className="impact-pill muted">No change in rate yet</span>
                    )}
                    {ce.status === 'awaiting-games' && (
                      <span className="impact-pill info">Play new games to measure impact</span>
                    )}
                    {ce.status === 'untrained' && (
                      <button
                        className="small-btn"
                        onClick={() => startTraining([ce.category], undefined, undefined, true)}
                      >
                        Train theme →
                      </button>
                    )}
                  </div>

                  <div className="effectiveness-bar-row">
                    <div className="bar">
                      <div
                        className="bar-fill"
                        style={{ width: `${ce.trainedPct}%`, backgroundColor: ce.color }}
                      />
                    </div>
                    <span className="muted small">
                      {ce.trainedPositions} of {ce.totalPositions} trained ({ce.masteredPositions} solved)
                    </span>
                  </div>

                  <div className="effectiveness-detail small muted">
                    {ce.afterTrainingPerGame !== null ? (
                      <>
                        Before training ({ce.gamesBeforeTraining}{' '}
                        {ce.gamesBeforeTraining === 1 ? 'game' : 'games'}):{' '}
                        <strong>{ce.beforeTrainingPerGame} mistakes/game</strong> → After training (
                        {ce.gamesAfterTraining} {ce.gamesAfterTraining === 1 ? 'game' : 'games'}):{' '}
                        <strong className={ce.deltaPerGame && ce.deltaPerGame < 0 ? 'good' : undefined}>
                          {ce.afterTrainingPerGame} mistakes/game
                        </strong>
                      </>
                    ) : ce.trainedPositions > 0 ? (
                      <>
                        Pre-training baseline: <strong>{ce.beforeTrainingPerGame} mistakes per game</strong> across{' '}
                        {ce.gamesBeforeTraining} {ce.gamesBeforeTraining === 1 ? 'game' : 'games'}
                      </>
                    ) : (
                      <>
                        Current frequency: <strong>{ce.overallPerGame} mistakes per game</strong> (not trained yet)
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

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
            const catTrained = stats.byCategoryTrained.get(cat) ?? 0;
            const catUntrained = count - catTrained;
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
                  <span className="trained-badge muted small" title={`${catTrained} trained, ${catUntrained} not yet trained`}>
                    {catTrained === count ? (
                      <span className="good">✓ all trained</span>
                    ) : (
                      `${catTrained}/${count} trained`
                    )}
                  </span>
                  <span className="count">{count}</span>
                  <span className="chev">{isOpen ? '▾' : '▸'}</span>
                </button>
                {isOpen && cat === 'hung-piece' ? (
                  <div className="phase-rows">
                    {hungPieces.map(({ piece, total: n, trained: pieceTrained, untrained: pieceUntrained }) => (
                      <div key={piece} className="phase-row">
                        <span className="phase-name">{piece}</span>
                        <span className="trained-badge muted small" title={`${pieceTrained} trained, ${pieceUntrained} not yet trained`}>
                          {pieceTrained === n ? (
                            <span className="good">✓ all {n} trained</span>
                          ) : (
                            `${pieceTrained}/${n} trained`
                          )}
                        </span>
                        <div className="row gap" style={{ marginLeft: 'auto' }}>
                          {pieceUntrained > 0 && pieceTrained > 0 ? (
                            <>
                              <button
                                className="small-btn primary"
                                onClick={() => startTraining([cat], undefined, piece, true)}
                                title={`Train only the ${pieceUntrained} positions not yet trained`}
                              >
                                Train {pieceUntrained} untrained →
                              </button>
                              <button
                                className="small-btn"
                                onClick={() => startTraining([cat], undefined, piece, false)}
                                title={`Train all ${n} positions with hung ${piece}`}
                              >
                                All {n}
                              </button>
                            </>
                          ) : (
                            <button
                              className="small-btn"
                              onClick={() => startTraining([cat], undefined, piece, false)}
                              title={pieceTrained === n ? `Re-train all ${n} positions` : `Train all ${n} positions`}
                            >
                              Train {pieceTrained === n ? `all ${n}` : `these ${n}`} →
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    <div className="phase-row">
                      <span className="phase-name muted">all pieces</span>
                      <span className="trained-badge muted small" title={`${catTrained} trained, ${catUntrained} not yet trained`}>
                        {catTrained === count ? (
                          <span className="good">✓ all {count} trained</span>
                        ) : (
                          `${catTrained}/${count} trained`
                        )}
                      </span>
                      <div className="row gap" style={{ marginLeft: 'auto' }}>
                        {catUntrained > 0 && catTrained > 0 ? (
                          <>
                            <button
                              className="small-btn primary"
                              onClick={() => startTraining([cat], undefined, undefined, true)}
                              title={`Train only the ${catUntrained} positions not yet trained`}
                            >
                              Train {catUntrained} untrained →
                            </button>
                            <button
                              className="small-btn"
                              onClick={() => startTraining([cat], undefined, undefined, false)}
                              title={`Train all ${count} positions`}
                            >
                              All {count}
                            </button>
                          </>
                        ) : (
                          <button
                            className="small-btn"
                            onClick={() => startTraining([cat], undefined, undefined, false)}
                            title={catTrained === count ? `Re-train all ${count} positions` : `Train all ${count} positions`}
                          >
                            Train all {count} →
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ) : isOpen && (
                  <div className="phase-rows">
                    {PHASES.map(phase => {
                      const n = stats.byCategoryPhase.get(`${cat}|${phase}`) ?? 0;
                      if (n === 0) return null;
                      const phaseTrained = stats.byCategoryPhaseTrained.get(`${cat}|${phase}`) ?? 0;
                      const phaseUntrained = n - phaseTrained;
                      return (
                        <div key={phase} className="phase-row">
                          <span className="phase-name">{PHASE_LABEL[phase]}</span>
                          <span className="trained-badge muted small" title={`${phaseTrained} trained, ${phaseUntrained} not yet trained`}>
                            {phaseTrained === n ? (
                              <span className="good">✓ all {n} trained</span>
                            ) : (
                              `${phaseTrained}/${n} trained`
                            )}
                          </span>
                          <div className="row gap" style={{ marginLeft: 'auto' }}>
                            {phaseUntrained > 0 && phaseTrained > 0 ? (
                              <>
                                <button
                                  className="small-btn primary"
                                  onClick={() => startTraining([cat], phase, undefined, true)}
                                  title={`Train only the ${phaseUntrained} positions not yet trained`}
                                >
                                  Train {phaseUntrained} untrained →
                                </button>
                                <button
                                  className="small-btn"
                                  onClick={() => startTraining([cat], phase, undefined, false)}
                                  title={`Train all ${n} positions in the ${phase}`}
                                >
                                  All {n}
                                </button>
                              </>
                            ) : (
                              <button
                                className="small-btn"
                                onClick={() => startTraining([cat], phase, undefined, false)}
                                title={phaseTrained === n ? `Re-train all ${n} positions` : `Train all ${n} positions`}
                              >
                                Train {phaseTrained === n ? `all ${n}` : `these ${n}`} →
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    <div className="phase-row">
                      <span className="phase-name muted">all phases</span>
                      <span className="trained-badge muted small" title={`${catTrained} trained, ${catUntrained} not yet trained`}>
                        {catTrained === count ? (
                          <span className="good">✓ all {count} trained</span>
                        ) : (
                          `${catTrained}/${count} trained`
                        )}
                      </span>
                      <div className="row gap" style={{ marginLeft: 'auto' }}>
                        {catUntrained > 0 && catTrained > 0 ? (
                          <>
                            <button
                              className="small-btn primary"
                              onClick={() => startTraining([cat], undefined, undefined, true)}
                              title={`Train only the ${catUntrained} positions not yet trained`}
                            >
                              Train {catUntrained} untrained →
                            </button>
                            <button
                              className="small-btn"
                              onClick={() => startTraining([cat], undefined, undefined, false)}
                              title={`Train all ${count} positions`}
                            >
                              All {count}
                            </button>
                          </>
                        ) : (
                          <button
                            className="small-btn"
                            onClick={() => startTraining([cat], undefined, undefined, false)}
                            title={catTrained === count ? `Re-train all ${count} positions` : `Train all ${count} positions`}
                          >
                            Train all {count} →
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="row gap wrap" style={{ marginTop: 16 }}>
          {(() => {
            const totalUntrained = queueInfo.items.filter(i => (trainingStats[i.posKey]?.attempts ?? 0) === 0).length;
            const totalTrained = queueInfo.items.length - totalUntrained;
            return (
              <>
                {totalUntrained > 0 && totalUntrained < queueInfo.items.length ? (
                  <>
                    <button
                      className="primary big"
                      onClick={() => startTraining(undefined, undefined, undefined, true)}
                      title={`Train only the ${totalUntrained} positions not yet trained`}
                    >
                      ▶ Train {positions(totalUntrained)} untrained
                    </button>
                    <button
                      className="big"
                      onClick={() => startTraining()}
                      title="Train all positions, most common pattern first"
                    >
                      Train all ({queueInfo.items.length})
                    </button>
                  </>
                ) : (
                  <button
                    className="primary big"
                    onClick={() => startTraining()}
                    disabled={queueInfo.items.length === 0}
                    title="Train every mapped mistake position, most common pattern first"
                  >
                    ▶ Start training session ({positions(queueInfo.items.length)})
                  </button>
                )}
                {queueInfo.items.length > 0 && (
                  <span className="muted small" style={{ marginLeft: 6 }}>
                    {totalTrained} of {queueInfo.items.length} trained ({Math.round((totalTrained / queueInfo.items.length) * 100)}%)
                  </span>
                )}
              </>
            );
          })()}
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
