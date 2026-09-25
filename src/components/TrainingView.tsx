import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import type { GradeOutcome } from '../lib/training';
import { gradeMove, buildTrainingQueue } from '../lib/training';
import { CATEGORY_META } from '../lib/classify';
import { Board, type BoardArrow } from './Board';
import { Chess } from 'chess.js';
import { MATE_BASE, getEnginePool } from '../lib/engine';
import { formatEval } from '../lib/analysis';

interface FeedbackState {
  outcome: GradeOutcome;
  yourSan: string;
  bestSan: string;
}

function sanOf(fen: string, uci: string): string {
  try {
    const c = new Chess(fen);
    const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
    return m.san;
  } catch {
    return uci;
  }
}

/** Position after applying the first `steps` moves of the pv (starting from fen). */
function pvFen(fen: string, pv: string[] | undefined, steps: number): string {
  const c = new Chess();
  try {
    c.load(fen);
  } catch {
    return fen;
  }
  const n = Math.min(steps, pv?.length ?? 0);
  for (let i = 0; i < n; i++) {
    const uci = pv![i];
    try {
      c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
    } catch {
      break;
    }
  }
  return c.fen();
}

export function TrainingView() {
  const { training, commitTraining, countAttempt, endTraining, startTraining, analyses, games, settings, trainingStats, dismissed } = useStore();
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [failedAttempt, setFailedAttempt] = useState(false); // used Try again (or wrong) on this position
  const [hintUsed, setHintUsed] = useState(false); // hint arrow or best-line peeked before solving
  const [grading, setGrading] = useState(false);
  const [hint, setHint] = useState(false);
  const [exploreStep, setExploreStep] = useState<number | null>(null); // best-line playback step
  // the position after the user's attempt — keeps the piece where they dropped it
  const [triedFen, setTriedFen] = useState<string | null>(null);
  // free-play mode: play both sides, engine evaluates live; session score unaffected
  const [freeExplore, setFreeExplore] = useState<{
    startFen: string;
    fen: string;
    sans: string[];
    analyzing: boolean;
    evalText?: string;
    bestSan?: string;
    bestUci?: string;
    lineSans?: string[];
    endText?: string;
  } | null>(null);
  const exploreToken = useRef(0);

  const item = training.active ? training.queue[training.index] : undefined;

  // new position served (after commit) — reset the per-position state
  useEffect(() => {
    setFeedback(null);
    setHint(false);
    setHintUsed(false);
    setGrading(false);
    setFailedAttempt(false);
    setTriedFen(null);
    setExploreStep(null);
    setFreeExplore(null);
  }, [item?.posKey, training.index, training.step]);

  const orientation = useMemo<'white' | 'black'>(() => {
    if (!item) return 'white';
    return item.fen.split(' ')[1] === 'b' ? 'black' : 'white';
  }, [item]);

  // SAN rendering of the engine's line, e.g. "Ra6 Qa3 Rb6 Kf7".
  // NOTE: must live above the early returns — hooks cannot be conditional.
  const pvSans = useMemo(() => {
    if (!item) return [];
    const line = item.best[0]?.pv;
    if (!line || line.length === 0) return [];
    const c = new Chess();
    try {
      c.load(item.fen);
    } catch {
      return [];
    }
    const sans: string[] = [];
    for (const uci of line) {
      try {
        const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
        sans.push(m.san);
      } catch {
        break;
      }
    }
    return sans;
  }, [item]);

  const handleMove = async (uci: string) => {
    if (!item || grading || feedback || exploreStep !== null) return;
    const chess = new Chess();
    try {
      chess.load(item.fen);
    } catch {
      return;
    }
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
    } catch {
      return; // illegal move — board already rejected it
    }
    const fenAfter = chess.fen();
    const terminal = chess.isCheckmate() ? 'checkmate' : chess.isStalemate() ? 'stalemate' : null;
    setTriedFen(fenAfter); // show the move on the board while grading
    setGrading(true);
    const outcome = await gradeMove(item, uci, fenAfter, terminal, Math.max(8, settings.depth - 3));
    if (outcome.result === 'wrong') setFailedAttempt(true);
    countAttempt(); // every graded move counts as an attempt
    setFeedback({ outcome, yourSan: sanOf(item.fen, uci), bestSan: item.best[0]?.san ?? item.best[0]?.uci ?? '?' });
    setGrading(false);
  };

  // ---- free exploration: play both sides, live engine evaluation ----

  const analyzeFree = async (fen: string) => {
    const token = ++exploreToken.current;
    setFreeExplore(e => (e && e.fen === fen ? { ...e, analyzing: true } : e));
    try {
      const pool = await getEnginePool();
      const r = await pool.analyze(fen, Math.max(8, settings.depth - 4), 1, 8000);
      if (exploreToken.current !== token) return;
      const turn: 'w' | 'b' = fen.split(' ')[1] === 'b' ? 'b' : 'w';
      setFreeExplore(e =>
        e && e.fen === fen
          ? {
              ...e,
              analyzing: false,
              evalText: formatEval(r.lines[0].cp, turn),
              bestSan: sanOf(fen, r.lines[0].uci),
              bestUci: r.lines[0].uci,
              lineSans: (r.lines[0].pv ?? []).slice(1, 5).map(u => sanOf(fen, u)),
            }
          : e
      );
    } catch {
      if (exploreToken.current === token) {
        setFreeExplore(e => (e && e.fen === fen ? { ...e, analyzing: false, evalText: '—' } : e));
      }
    }
  };

  const startFreeExplore = (fromFen: string) => {
    setExploreStep(null); // leave line playback if active
    setFreeExplore({ startFen: fromFen, fen: fromFen, sans: [], analyzing: false });
    void analyzeFree(fromFen);
  };

  const handleFreeMove = (uci: string) => {
    if (!freeExplore) return;
    const c = new Chess();
    try {
      c.load(freeExplore.fen);
    } catch {
      return;
    }
    let mv;
    try {
      mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
    } catch {
      return;
    }
    const fenAfter = c.fen();
    const endText = c.isCheckmate()
      ? `Checkmate — ${c.turn() === 'w' ? 'Black' : 'White'} wins`
      : c.isStalemate()
        ? 'Draw — stalemate'
        : c.isInsufficientMaterial() || c.isThreefoldRepetition()
          ? 'Draw'
          : null;
    setFreeExplore({
      ...freeExplore,
      fen: fenAfter,
      sans: [...freeExplore.sans, mv.san],
      analyzing: false,
      evalText: endText ?? undefined,
      bestSan: undefined,
      bestUci: undefined,
      lineSans: undefined,
      endText: endText ?? undefined,
    });
    if (!endText) void analyzeFree(fenAfter);
  };

  const freeReset = () => {
    if (!freeExplore) return;
    const fen = freeExplore.startFen;
    setFreeExplore({ ...freeExplore, fen, sans: [], analyzing: false, evalText: undefined, bestSan: undefined, bestUci: undefined, lineSans: undefined, endText: undefined });
    void analyzeFree(fen);
  };

  const queueInfo = useMemo(() => {
    if (!training.active && Object.keys(analyses).length > 0) {
      return buildTrainingQueue(Object.values(analyses), games, undefined, undefined, trainingStats, undefined, dismissed);
    }
    return { items: [], categories: [] };
  }, [training.active, analyses, games, trainingStats, dismissed]);

  const untrainedCount = useMemo(() => {
    return queueInfo.items.filter(i => (trainingStats[i.posKey]?.attempts ?? 0) === 0).length;
  }, [queueInfo.items, trainingStats]);

  if (!training.active) {
    const canTrain = Object.keys(analyses).length > 0;
    return (
      <div className="view">
        <div className="card empty-state">
          <h2>Training room</h2>
          {canTrain ? (
            <>
              <p className="muted">
                Replay the exact positions where you went wrong, most common mistake first. The board shows the position
                <b> before</b> your mistake — find the better move. Positions you miss come back later in the session.
              </p>
              <div className="row gap" style={{ justifyContent: 'center', marginTop: 12 }}>
                {untrainedCount > 0 && untrainedCount < queueInfo.items.length ? (
                  <>
                    <button className="primary big" onClick={() => startTraining(undefined, undefined, undefined, true)}>
                      ▶ Train {untrainedCount} untrained mistakes
                    </button>
                    <button className="big" onClick={() => startTraining()}>
                      Train all ({queueInfo.items.length})
                    </button>
                  </>
                ) : (
                  <button className="primary big" onClick={() => startTraining()}>
                    ▶ Train all mistakes ({queueInfo.items.length})
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="muted">Analyze some games first — then come here to drill your mistakes.</p>
          )}
        </div>
      </div>
    );
  }

  // session finished
  if (!item) {
    const solved = training.firstTry + training.retried;
    return (
      <div className="view">
        <div className="card empty-state">
          <h2>Session complete 🎉</h2>
          <p className="muted">
            Immediate solves (never failed this session): <b>{training.firstTry}</b> · solved after a retry or requeue:{' '}
            <b>{training.retried}</b> · with a hint visible: <b>{training.hintSolved}</b> · skipped:{' '}
            <b>{training.skipped}</b> · total attempts: <b>{training.attempts}</b>
            {solved + training.skipped === 0 && <> — no attempts were committed.</>}
          </p>
          <div className="row gap">
            <button className="primary" onClick={() => startTraining()}>
              Go again (same data)
            </button>
            <button onClick={() => endTraining('map')}>Back to Mistake Map</button>
          </div>
        </div>
      </div>
    );
  }

  const meta = CATEGORY_META[item.category];
  const catRank = training.categories.findIndex(c => c.key === item.category);
  const catCount = training.categories[catRank]?.count ?? 0;
  const done = training.firstTry + training.retried + training.skipped;
  const pv = item.best[0]?.pv;
  const exploring = exploreStep !== null;
  const nextPvMove = exploring && pv && exploreStep < pv.length ? pv[exploreStep] : null;
  // free explore owns the board; otherwise line playback, then the user's tried
  // move, then the training position itself
  const boardFen = freeExplore
    ? freeExplore.fen
    : exploring
      ? pvFen(item.fen, pv, exploreStep)
      : triedFen ?? item.fen;


  const arrows: BoardArrow[] = [];
  // the move you actually played last time — visible on the training position,
  // hidden once the board walks away into the best-line playback
  if (!exploring && !freeExplore && item.playedUci && item.playedUci.length >= 4) {
    arrows.push({ from: item.playedUci.slice(0, 2), to: item.playedUci.slice(2, 4), color: '#e5484d' });
  }
  if (!feedback && hint && !grading && !exploring && !freeExplore && item.best[0]?.uci) {
    arrows.push({ from: item.best[0].uci.slice(0, 2), to: item.best[0].uci.slice(2, 4), color: '#4ade80' });
  }
  // while reviewing (not replaying the line and not free-exploring), point out
  // the engine's best move for the ROOT position — during exploration the board
  // shows a different position, where the live suggestion arrow takes over
  if (feedback && !exploring && !freeExplore && item.best[0]?.uci) {
    arrows.push({ from: item.best[0].uci.slice(0, 2), to: item.best[0].uci.slice(2, 4), color: '#4ade80' });
  }
  if (exploring && nextPvMove) {
    arrows.push({ from: nextPvMove.slice(0, 2), to: nextPvMove.slice(2, 4), color: '#8ab4f8' });
  }
  // free exploration: point at the engine's suggestion for the current position
  if (freeExplore && !freeExplore.analyzing && freeExplore.bestUci) {
    arrows.push({ from: freeExplore.bestUci.slice(0, 2), to: freeExplore.bestUci.slice(2, 4), color: '#4ade80' });
  }

  const bestEvalStr = (() => {
    const cp = item.best[0]?.cp ?? 0;
    if (cp > MATE_BASE - 10_000) return 'forces mate';
    if (cp < -(MATE_BASE - 10_000)) return 'was the only defense';
    return `${cp >= 0 ? '+' : ''}${(cp / 100).toFixed(1)} for you`;
  })();

  const isSolved = feedback ? feedback.outcome.result !== 'wrong' : false;
  const isLastInQueue = training.queue.length <= 1;
  const nextLabel = isSolved
    ? isLastInQueue
      ? 'Finish session 🎉'
      : 'Next position →'
    : isLastInQueue
      ? 'Try again'
      : 'Next (comes back later)';

  const onNext = () => {
    if (!feedback) return;
    if (feedback.outcome.result === 'wrong' && isLastInQueue) {
      setFeedback(null);
      setTriedFen(null);
      return;
    }
    const correct = feedback.outcome.result !== 'wrong';
    setFeedback(null);
    setTriedFen(null);
    setExploreStep(null);
    void commitTraining({ correct, retried: failedAttempt, hintUsed, skipped: false });
  };

  return (
    <div className="view training">
      <div className="training-top">
        <div className="muted">
          ✅ {training.firstTry} immediate solves · 🔁 {training.retried} after retry · 💡 {training.hintSolved} with hint ·
          ⏭ {training.skipped} skipped · 🎯 {training.attempts} attempts · ⬜ {training.queue.length} left
        </div>
        <button className="small-btn danger-text" onClick={() => endTraining('map')}>
          End session
        </button>
      </div>

      <div className="card training-card">
        <div className="mistake-context">
          <span className="rank">Pattern #{catRank + 1}</span>
          <span className="icon">{meta.icon}</span>
          <span className="mistake-label" style={{ color: meta.color }} title={meta.description}>
            {meta.label}
            {item.hungPiece ? ` (${item.hungPiece})` : ''}
          </span>
          <span className="muted">
            · {item.phase} · {catCount}× overall · last time you played <b>{item.playedSan}</b>
          </span>
          {trainingStats[item.posKey]?.attempts ? (
            <span className="chip small" style={{ fontSize: '11px', padding: '2px 8px' }} title={`Trained ${trainingStats[item.posKey].attempts} time${trainingStats[item.posKey].attempts === 1 ? '' : 's'} (${trainingStats[item.posKey].correct} solved)`}>
              previously trained ({trainingStats[item.posKey].correct}/{trainingStats[item.posKey].attempts})
            </span>
          ) : (
            <span className="chip small" style={{ fontSize: '11px', padding: '2px 8px', opacity: 0.75 }}>
              new position
            </span>
          )}
        </div>
        {item.reason && (
          <p className="muted small" style={{ marginTop: 2 }}>
            <b>Why this label:</b> {item.reason}
            {item.confidence && <> · confidence: <b>{item.confidence}</b></>}
          </p>
        )}
        <p className="muted small">
          {orientation === 'white' ? 'White' : 'Black'} to move — find the strong move. From: {item.gameLabel}
          {item.gameUrl && (
            <>
              {' · '}
              <a href={item.gameUrl} target="_blank" rel="noreferrer">
                view game
              </a>
            </>
          )}
        </p>

        <Board
          fen={boardFen}
          orientation={orientation}
          onMove={uci => (freeExplore ? handleFreeMove(uci) : handleMove(uci))}
          arrows={arrows}
          interactive={!grading && (freeExplore ? true : !feedback && !exploring)}
        />

        <div className="feedback-area">
          {!grading && feedback && (
            <div className={`alert ${feedback.outcome.result === 'wrong' ? 'error' : 'ok'}`}>
              <div className="feedback-title">
                {feedback.outcome.result === 'wrong'
                  ? '❌ Not this time'
                  : failedAttempt
                    ? '🔁 Got it on the retry'
                    : feedback.outcome.message.includes('Checkmate')
                      ? '👑'
                      : '✅ Right!'}{' '}
                {feedback.outcome.message}
              </div>
              <div>
                You played <b>{feedback.yourSan}</b>. Engine best: <b>{feedback.bestSan}</b> ({bestEvalStr}).
              </div>
              {!exploring && (
                <div className="row gap" style={{ marginTop: 10 }}>
                  <button className="primary" onClick={onNext}>
                    {nextLabel}
                  </button>
                  {(!isLastInQueue || feedback.outcome.result !== 'wrong') && (
                    <button
                      onClick={() => {
                        setFeedback(null);
                        setTriedFen(null); // piece returns to its original square
                      }}
                    >
                      ↻ Try again
                    </button>
                  )}
                  {isLastInQueue && feedback.outcome.result === 'wrong' && (
                    <button
                      className="small-btn"
                      onClick={() => void commitTraining({ correct: false, skipped: true })}
                      title="Skip this position and finish the session"
                    >
                      Skip & finish
                    </button>
                  )}
                  {pv && pv.length > 1 && (
                    <button
                      onClick={() => {
                        setHintUsed(true);
                        setExploreStep(1);
                      }}
                    >
                      👁 Play the best line
                    </button>
                  )}
                  <button
                    className="small-btn"
                    title="The engine flagged this move, but you disagree — it will be removed from your stats and training queue"
                    onClick={() => {
                      setFeedback(null);
                      setTriedFen(null);
                      void commitTraining({ dismissed: true });
                    }}
                  >
                    🏷 Not a mistake
                  </button>
                  <button
                    className="small-btn"
                    onClick={() => startFreeExplore(triedFen ?? item.fen)}
                    title="Keep playing both sides — the engine evaluates every position live"
                  >
                    🔍 Explore continuations
                  </button>
                </div>
              )}
            </div>
          )}
          {grading && <div className="alert info">Checking your move…</div>}
          {exploring && (
            <div className="alert info">
              <div className="feedback-title">
                👁 Best line — move {Math.min(exploreStep, pv?.length ?? 0)}/{pv?.length ?? 0}
              </div>
              <div className="pv-line">
                {pvSans.map((san, i) => (
                  <span
                    key={i}
                    className={i < exploreStep ? 'pv-move pv-move-done' : 'pv-move'}
                  >
                    {i % 2 === 0 ? `${i / 2 + 1}.` : ''}
                    {san}
                  </span>
                ))}
              </div>
              <div className="row gap" style={{ marginTop: 8 }}>
                <button
                  className="primary"
                  onClick={() => setExploreStep(s => (s ?? 0) + 1)}
                  disabled={!nextPvMove}
                  style={{ opacity: nextPvMove ? 1 : 0.5 }}
                >
                  Next move →
                </button>
                <button onClick={() => setExploreStep(s => Math.max(1, (s ?? 1) - 1))} disabled={exploreStep <= 1}>
                  ← Back one
                </button>
                <button
                  onClick={() => {
                    const fen = pvFen(item.fen, pv, exploreStep);
                    startFreeExplore(fen); // leaves playback and enables free play
                  }}
                >
                  ✍️ Continue playing from here
                </button>
                <button onClick={() => setExploreStep(null)}>✕ Back to the position</button>
              </div>
              <div className="muted small" style={{ marginTop: 6 }}>
                🟢 green = engine best · 🔵 blue = next move in the line
              </div>
            </div>
          )}
          {!grading && !feedback && !exploring && (
            <div className="row gap">
              <button
                className="small-btn"
                onClick={() => {
                  setHint(true);
                  setHintUsed(true);
                }}
                disabled={hint}
              >
                💡 Hint arrow
              </button>
              {pv && pv.length > 1 && (
                <button
                  className="small-btn"
                  onClick={() => {
                    setHintUsed(true);
                    setExploreStep(1);
                  }}
                >
                  👁 Play the best line
                </button>
              )}
              <button className="small-btn" onClick={() => void commitTraining({ correct: false, skipped: true })}>
                {isLastInQueue ? 'Skip & finish' : 'Skip (comes back later)'}
              </button>
              <button className="small-btn" onClick={() => startFreeExplore(item.fen)}>
                🔍 Explore
              </button>
            </div>
          )}
          {!grading && freeExplore && (
            <div className="alert info">
              <div className="feedback-title">
                🔍 Exploring{' '}
                {freeExplore.analyzing
                  ? '— engine thinking…'
                  : freeExplore.endText
                    ? `— ${freeExplore.endText}`
                    : freeExplore.evalText
                      ? `— engine eval ${freeExplore.evalText} (best: ${freeExplore.bestSan})`
                      : ''}
              </div>
              {freeExplore.sans.length > 0 && (
                <div className="pv-line">
                  {freeExplore.sans.map((san, i) => (
                    <span key={i} className={i === freeExplore.sans.length - 1 ? 'pv-move pv-move-done' : 'pv-move'}>
                      {i % 2 === 0 ? `${i / 2 + 1}.` : ''}
                      {san}
                    </span>
                  ))}
                </div>
              )}
              {!freeExplore.analyzing && freeExplore.lineSans && freeExplore.lineSans.length > 0 && (
                <div className="muted small">Engine expects: {freeExplore.lineSans.join(' ')}</div>
              )}
              <div className="row gap" style={{ marginTop: 8 }}>
                <button className="primary" onClick={freeReset}>
                  ⟲ Reset position
                </button>
                <button
                  onClick={() => {
                    exploreToken.current++; // invalidate any in-flight analysis
                    setFreeExplore(null);
                  }}
                >
                  ✕ Exit explore
                </button>
              </div>
              <div className="muted small" style={{ marginTop: 6 }}>
                Free play for both sides — click or drag moves; the engine evaluates every position live. Your session
                score is not affected here.
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="muted small center">
        Queue: most common pattern first —{' '}
        {training.categories.map(c => `${CATEGORY_META[c.key].label} ×${c.count}`).join(' · ')}
      </div>
    </div>
  );
}
