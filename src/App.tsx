import { useEffect } from 'react';
import { useStore, type View } from './store';
import { ImportView } from './components/ImportView';
import { Dashboard } from './components/Dashboard';
import { TrainingView } from './components/TrainingView';
import { GamesView } from './components/GamesView';

const TABS: { key: View; label: string }[] = [
  { key: 'import', label: '1 · Import & Analyze' },
  { key: 'map', label: '2 · Mistake Map' },
  { key: 'train', label: '3 · Train' },
  { key: 'games', label: 'Games' },
];

export function App() {
  const { view, setView, hydrate, engine, ensureEngine } = useStore();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">
          <span className="logo">♞</span>
          <div>
            <h1>Chess Mistake Trainer</h1>
            <div className="muted small">
              Lichess + Chess.com → Stockfish → your most common mistakes → drill them
            </div>
          </div>
        </div>
        <button className="engine-badge" onClick={() => void ensureEngine()} title="Click to load the engine">
          <span
            className={`dot ${
              engine.status === 'ready' ? 'good' : engine.status === 'error' ? 'bad' : engine.status === 'loading' ? 'warn' : ''
            }`}
          />
          {engine.status === 'ready'
            ? engine.name
            : engine.status === 'loading'
              ? 'loading engine…'
              : engine.status === 'error'
                ? 'engine error'
                : 'engine idle'}
        </button>
      </header>

      <nav className="tabs">
        {TABS.map(t => (
          <button key={t.key} className={`tab ${view === t.key ? 'tab-on' : ''}`} onClick={() => setView(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {view === 'import' && <ImportView />}
        {view === 'map' && <Dashboard />}
        {view === 'train' && <TrainingView />}
        {view === 'games' && <GamesView />}
      </main>

      <footer className="muted small center">
        Runs entirely in your browser · analysis by Stockfish (GPLv3) · your data never leaves this machine
      </footer>
    </div>
  );
}
