import { useMemo, useState, type CSSProperties } from 'react';
import { useStore } from '../store';
import type { GameAnalysis, GameRecord, TrainingItem } from '../types';
import { CATEGORY_META } from '../lib/classify';
import { computeReviewStats, estimateGameElo, formatEval, gameLabel } from '../lib/analysis';
import { getGameRatings } from '../lib/pgn';
import { posKeyOf } from '../lib/training';
import { Board, type BoardArrow } from './Board';
import { isMateScore } from '../lib/engine';

function whiteEval(ply: { evalBefore: number }, moverColor: 'w' | 'b'): number {
  const cp = ply.evalBefore;
  return moverColor === 'w' ? cp : -cp;
}

function plyColor(ply: { ply: number }): 'w' | 'b' {
  return (ply.ply - 1) % 2 === 0 ? 'w' : 'b';
}

export function GamesView() {
  const { games, analyses, deleteGame, setView } = useStore();
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  const rows = useMemo(
    () =>
      Object.values(games)
        .sort((a, b) => (b.playedAt ?? '').localeCompare(a.playedAt ?? ''))
        .map(g => ({ game: g, analysis: analyses[g.key] })),
    [games, analyses]
  );
  const stats = useMemo(() => computeReviewStats(rows), [rows]);
  const siteEntries = useMemo(() => {
    return (Object.entries(stats.bySite) as [import('../types').Site, import('../lib/analysis').SiteStats][]).filter(
      ([_, s]) => s && s.games > 0
    );
  }, [stats.bySite]);

  if (rows.length === 0) {
    return (
      <div className="view">
        <div className="card empty-state">
          <h2>No games yet</h2>
          <p className="muted">Import games to see them here with accuracy and per-move review.</p>
          <button className="primary" onClick={() => setView('import')}>
            Go to import
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="view">
      <div className="stat-row">
        <div className="stat">
          {siteEntries.length === 0 ? (
            <>
              <div className="stat-value">—</div>
              <div className="stat-label">avg rating (elo)</div>
            </>
          ) : siteEntries.length === 1 ? (
            <>
              <div className="stat-value">{siteEntries[0][1].avgRating}</div>
              <div className="stat-label">
                avg rating ({siteEntries[0][0] === 'lichess' ? 'Lichess' : siteEntries[0][0] === 'chesscom' ? 'Chess.com' : 'Import'})
              </div>
            </>
          ) : (
            <>
              <div className="stat-value" style={{ fontSize: '1.15rem', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {siteEntries.map(([site, s]) => (
                  <span key={site}>
                    {site === 'lichess' ? 'Lichess' : site === 'chesscom' ? 'Chess.com' : 'Import'}: <b>{s.avgRating}</b>
                  </span>
                ))}
              </div>
              <div className="stat-label">avg rating by platform</div>
            </>
          )}
        </div>
        <div className="stat">
          <div className="stat-value">{stats.avgAccuracy > 0 ? `${stats.avgAccuracy}%` : '—'}</div>
          <div className="stat-label">avg accuracy</div>
        </div>
        <div className="stat">
          <div className="stat-value">{stats.analyzedGames} / {rows.length}</div>
          <div className="stat-label">games reviewed</div>
        </div>
      </div>

      <section className="card">
        <h2>Your games ({rows.length})</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Game</th>
              <th>TC</th>
              <th>Result</th>
              <th>Accuracy</th>
              <th>Est. Elo</th>
              <th>Mistakes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ game, analysis }) => (
              <tr key={game.key}>
                <td className="muted">{game.playedAt ?? '—'}</td>
                <td>
                  {gameLabel(game)}
                  <div className="muted small">{game.opening ? `${game.opening.eco} ${game.opening.name}` : ''}</div>
                </td>
                <td>{game.timeClass}</td>
                <td className={game.playerResult === 'win' ? 'good' : game.playerResult === 'loss' ? 'bad' : ''}>
                  {game.playerResult}
                </td>
                <td>{analysis ? `${analysis.accuracy}%${analysis.partial ? ' ⚠︎partial' : ''}` : '—'}</td>
                <td>{analysis ? estimateGameElo(game, analysis) : '—'}</td>
                <td>{analysis ? analysis.mistakeCount : '—'}</td>
                <td className="row gap">
                  {analysis && (
                    <button className="small-btn" onClick={() => setReviewKey(game.key)}>
                      Review
                    </button>
                  )}
                  <button className="small-btn danger-text" onClick={() => void deleteGame(game.key)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {reviewKey && <ReviewModal gameKey={reviewKey} onClose={() => setReviewKey(null)} />}
    </div>
  );
}

function mistakeToItem(ply: GameAnalysis['plies'][number], game: GameRecord): TrainingItem {
  return {
    posKey: posKeyOf(ply.fenBefore),
    fen: ply.fenBefore,
    category: ply.category!,
    phase: ply.phase ?? 'middlegame',
    cpl: ply.cpl,
    best: ply.best,
    playedSan: ply.playedSan,
    playedUci: ply.playedUci,
    gameKey: game.key,
    gameLabel: gameLabel(game),
    gameUrl: game.url,
    hungPiece: ply.hungPiece,
  };
}

function ReviewModal({ gameKey, onClose }: { gameKey: string; onClose: () => void }) {
  const { games, analyses, trainPositions, dismissLabel, trainingStats } = useStore();
  const game: GameRecord | undefined = games[gameKey];
  const analysis: GameAnalysis | undefined = analyses[gameKey];
  const mistakePlies = useMemo(() => (analysis ? analysis.plies.filter(p => p.category) : []), [analysis]);
  const untrainedMistakePlies = useMemo(
    () => mistakePlies.filter(p => (trainingStats[posKeyOf(p.fenBefore)]?.attempts ?? 0) === 0),
    [mistakePlies, trainingStats]
  );
  const [mistakeIdx, setMistakeIdx] = useState(0);
  const [plyIdx, setPlyIdx] = useState(mistakePlies[0]?.ply ?? 1);

  if (!game || !analysis) return null;
  const ply = analysis.plies.find(p => p.ply === plyIdx) ?? analysis.plies[0];
  if (!ply) return null;

  const jumpMistake = (delta: number) => {
    if (mistakePlies.length === 0) return;
    const next = (mistakeIdx + delta + mistakePlies.length) % mistakePlies.length;
    setMistakeIdx(next);
    setPlyIdx(mistakePlies[next].ply);
  };

  const orientation = analysis.playerColor === 'w' ? 'white' : 'black';
  const arrows: BoardArrow[] = [];
  const highlight: Record<string, CSSProperties> = {};
  if (ply.best.length > 0 && ply.category) {
    arrows.push({ from: ply.best[0].uci.slice(0, 2), to: ply.best[0].uci.slice(2, 4), color: '#4ade80' });
    arrows.push({ from: ply.playedUci.slice(0, 2), to: ply.playedUci.slice(2, 4), color: '#e5484d' });
  }
  highlight[ply.playedUci.slice(2, 4)] = { boxShadow: 'inset 0 0 6px rgba(229,72,77,0.9)' };
  const moveNo = Math.floor((ply.ply - 1) / 2) + 1;

  // eval graph points (white-centric, clamped for display)
  const graph = analysis.plies.map(p => {
    const we = whiteEval(p, plyColor(p));
    const clamped = isMateScore(we) ? (we > 0 ? 1000 : -1000) : Math.max(-1000, Math.min(1000, we));
    return clamped;
  });

  const gameRatings = getGameRatings(game);
  const elo = estimateGameElo(game, analysis);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" onClick={e => e.stopPropagation()}>
        <div className="row between">
          <div>
            <h3>
              Review: {gameLabel(game)} {game.url && <a href={game.url} target="_blank" rel="noreferrer" className="small">↗</a>}
            </h3>
            <div className="muted small">
              Accuracy: <b>{analysis.accuracy}%</b> · Est. Elo: <b>{elo}</b>{' '}
              <span className="muted">({game.site === 'lichess' ? 'Lichess' : game.site === 'chesscom' ? 'Chess.com' : 'Import'})</span>
              {gameRatings.playerRating ? (
                <span className="muted"> · rated {gameRatings.playerRating} in match</span>
              ) : null}
              {analysis.partial ? <span className="warn"> (partial analysis)</span> : null}
            </div>
          </div>
          <button className="small-btn" onClick={onClose}>
            ✕ close
          </button>
        </div>

        <div className="review-grid">
          <div>
            <Board fen={ply.fenBefore} orientation={orientation} arrows={arrows} highlight={highlight} interactive={false} />
            <div className="row between" style={{ marginTop: 8 }}>
              <div className="row gap">
                <button className="small-btn" onClick={() => setPlyIdx(Math.max(1, plyIdx - 1))}>
                  ← prev
                </button>
                {ply.category && (
                  <button
                    className="small-btn"
                    onClick={() => {
                      trainPositions([mistakeToItem(ply, game)]);
                      onClose();
                    }}
                    title="Drill this position in the training room"
                  >
                    🎯 Train this mistake {ply.category && (trainingStats[posKeyOf(ply.fenBefore)]?.attempts ?? 0) > 0 ? '(re-train)' : ''}
                  </button>
                )}
              </div>
              <span className="muted" style={{ textAlign: 'center' }}>
                move {moveNo}
                {plyColor(ply) === 'w' ? '.' : '...'} <b>{ply.playedSan}</b> · eval {formatEval(ply.evalBefore, plyColor(ply))}
                {ply.category && (
                  <span style={{ color: CATEGORY_META[ply.category].color }}>
                    {' '}
                    · {CATEGORY_META[ply.category].icon} {CATEGORY_META[ply.category].label}
                    {ply.hungPiece ? ` (${ply.hungPiece})` : ''} (-{(ply.cpl / 100).toFixed(1)})
                  </span>
                )}
                {ply.category && (
                  (trainingStats[posKeyOf(ply.fenBefore)]?.attempts ?? 0) > 0 ? (
                    <span className="good small"> · ✓ trained</span>
                  ) : (
                    <span className="muted small"> · not yet trained</span>
                  )
                )}
                {ply.category && ply.best[0] && (
                  <span className="good">
                    {' '}
                    · best: <b>{ply.best[0].san ?? ply.best[0].uci}</b>
                  </span>
                )}
                {ply.category && ply.reason && (
                  <div className="muted small">
                    Why: {ply.reason}
                    {ply.confidence && <> · confidence: {ply.confidence}</>}
                  </div>
                )}
              </span>
              <div className="row gap">
                {ply.category && (
                  <button
                    className="small-btn danger-text"
                    title="The engine flagged this move, but you disagree — removes it from the map and training queue"
                    onClick={() => void dismissLabel(posKeyOf(ply.fenBefore), ply.category!)}
                  >
                    🏷 Dismiss label
                  </button>
                )}
                {mistakePlies.length > 1 && (
                  <>
                    <button className="small-btn" onClick={() => jumpMistake(-1)} title="Previous mistake in this game">
                      ↖ mistake
                    </button>
                    <button className="small-btn" onClick={() => jumpMistake(1)} title="Next mistake in this game">
                      mistake ↘
                    </button>
                  </>
                )}
                <button className="small-btn" onClick={() => setPlyIdx(Math.min(analysis.plies.length, plyIdx + 1))}>
                  next →
                </button>
              </div>
            </div>
            {mistakePlies.length > 0 && (
              <div className="row between" style={{ marginTop: 8 }}>
                <span className="muted small">
                  Mistake {Math.min(mistakeIdx + 1, mistakePlies.length)}/{mistakePlies.length} in this game
                  {untrainedMistakePlies.length < mistakePlies.length && (
                    <> · {mistakePlies.length - untrainedMistakePlies.length}/{mistakePlies.length} trained</>
                  )}
                </span>
                <div className="row gap">
                  {untrainedMistakePlies.length > 0 && untrainedMistakePlies.length < mistakePlies.length ? (
                    <>
                      <button
                        className="small-btn primary"
                        onClick={() => {
                          trainPositions(untrainedMistakePlies.map(p => mistakeToItem(p, game)));
                          onClose();
                        }}
                      >
                        🎯 Train {untrainedMistakePlies.length} untrained
                      </button>
                      <button
                        className="small-btn"
                        onClick={() => {
                          trainPositions(mistakePlies.map(p => mistakeToItem(p, game)));
                          onClose();
                        }}
                      >
                        All {mistakePlies.length}
                      </button>
                    </>
                  ) : (
                    <button
                      className="small-btn"
                      onClick={() => {
                        trainPositions(mistakePlies.map(p => mistakeToItem(p, game)));
                        onClose();
                      }}
                    >
                      🎯 Train all {mistakePlies.length} mistakes of this game
                    </button>
                  )}
                </div>
              </div>
            )}
            <EvalGraph values={graph} mistakes={analysis.plies.map(p => !!p.category)} current={plyIdx} onJump={setPlyIdx} />
          </div>

          <div className="move-list">
            {chunkPairs(analysis.plies).map(([white, black], i) => (
              <div key={i} className="move-pair">
                <span className="move-no">{i + 1}.</span>
                {white && <MoveCell ply={white} active={white.ply === plyIdx} onClick={() => setPlyIdx(white.ply)} />}
                {black && <MoveCell ply={black} active={black.ply === plyIdx} onClick={() => setPlyIdx(black.ply)} />}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MoveCell({ ply, active, onClick }: { ply: GameAnalysis['plies'][number]; active: boolean; onClick: () => void }) {
  const cat = ply.category;
  return (
    <button
      className={`move-cell ${active ? 'active' : ''}`}
      style={cat ? { color: CATEGORY_META[cat].color, borderColor: CATEGORY_META[cat].color } : undefined}
      onClick={onClick}
      title={cat ? CATEGORY_META[cat].label : `eval ${formatEval(ply.evalBefore, plyColor(ply))}`}
    >
      {ply.playedSan}
    </button>
  );
}

function chunkPairs(plies: GameAnalysis['plies']): [GameAnalysis['plies'][number] | undefined, GameAnalysis['plies'][number] | undefined][] {
  const out: [GameAnalysis['plies'][number] | undefined, GameAnalysis['plies'][number] | undefined][] = [];
  for (let i = 0; i < plies.length; i += 2) {
    out.push([plies[i], plies[i + 1]]);
  }
  return out;
}

function EvalGraph({
  values,
  mistakes,
  current,
  onJump,
}: {
  values: number[];
  mistakes: boolean[];
  current: number;
  onJump: (ply: number) => void;
}) {
  const w = 560;
  const h = 80;
  const toX = (i: number) => (values.length <= 1 ? 0 : (i / (values.length - 1)) * w);
  const toY = (v: number) => h / 2 - (v / 1000) * (h / 2 - 4);
  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  return (
    <svg
      className="eval-graph"
      viewBox={`0 0 ${w} ${h}`}
      onClick={e => {
        const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const frac = (e.clientX - rect.left) / rect.width;
        onJump(Math.max(1, Math.min(values.length, Math.round(frac * (values.length - 1)) + 1)));
      }}
    >
      <rect width={w} height={h} fill="#20242c" rx={4} />
      <line x1={0} y1={h / 2} x2={w} y2={h / 2} stroke="#3a4150" strokeWidth={1} />
      <path d={path} fill="none" stroke="#8ab4f8" strokeWidth={2} />
      {mistakes.map((m, i) =>
        m ? <circle key={i} cx={toX(i)} cy={toY(values[i])} r={3.5} fill="#e5484d" /> : null
      )}
      <line x1={toX(current - 1)} y1={0} x2={toX(current - 1)} y2={h} stroke="#f5c542" strokeWidth={1} />
    </svg>
  );
}
