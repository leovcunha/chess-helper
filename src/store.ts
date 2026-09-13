import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Category, EngineSettings, GameAnalysis, GameRecord, ImportFilters, TrainingItem, TrainingStats } from './types';
import { dbGet, dbPut, dbBulkPut, dbGetAll, dbGetAllEntries, dbDelete, dbClear } from './lib/db';
import { analyzeGames, engineKeyOf, type AnalysisProgress } from './lib/analysis';
import { getEnginePool } from './lib/engine';
import { ANALYSIS_SCHEMA, reclassifyAnalysis } from './lib/classify';
import { buildTrainingQueue, type CategoryCount } from './lib/training';

export type View = 'import' | 'map' | 'train' | 'games';

interface JobState {
  active: boolean;
  cancelRequested: boolean;
  progress: AnalysisProgress | null;
  error: string | null;
  result: { analyzed: number; partial: number; failed: number; cancelled: boolean; failures: { game: string; reason: string }[]; skipped: number } | null;
}

export interface TrainingSession {
  queue: TrainingItem[];
  categories: CategoryCount[];
  index: number;
  total: number;
  active: boolean;
  // scoring: an "immediate solve" means the position was never failed before
  // this session (a later requeued presentation solving counts as a retry)
  firstTry: number;
  retried: number;
  skipped: number;
  hintSolved: number;
  attempts: number; // every graded move this session
  failsByPos: Record<string, number>; // posKey → times failed this session
}

export interface LabelDismissal {
  label: Category;
  at: number;
}

interface AppStore {
  view: View;
  setView: (v: View) => void;

  settings: EngineSettings;
  setSettings: (s: Partial<EngineSettings>) => void;
  filters: ImportFilters;
  setFilters: (f: Partial<ImportFilters>) => void;

  games: Record<string, GameRecord>;
  analyses: Record<string, GameAnalysis>; // keyed by gameKey (latest analysis wins)
  trainingStats: Record<string, TrainingStats>; // keyed by posKey
  dismissed: Record<string, LabelDismissal>; // posKey → user-rejected label
  hydrate: () => Promise<void>;
  addGames: (records: GameRecord[]) => Promise<number>;
  deleteGame: (key: string) => Promise<void>;

  importState: { active: boolean; message: string; error: string | null };
  setImportState: (s: Partial<{ active: boolean; message: string; error: string | null }>) => void;

  job: JobState;
  startAnalysis: (gameKeys: string[], reanalyzeAll: boolean) => Promise<void>;
  cancelAnalysis: () => void;

  engine: { status: 'unloaded' | 'loading' | 'ready' | 'error'; name?: string; error?: string };
  ensureEngine: () => Promise<void>;

  training: TrainingSession;
  startTraining: (categories?: Category[], phase?: string, piece?: string) => void;
  trainPositions: (items: TrainingItem[]) => void;
  countAttempt: () => void;
  commitTraining: (meta: { correct?: boolean; retried?: boolean; hintUsed?: boolean; skipped?: boolean; dismissed?: boolean }) => Promise<void>;
  skipTraining: () => void;
  dismissLabel: (posKey: string, label: Category) => Promise<void>;
  restoreLabels: () => Promise<void>;
  endTraining: (goTo?: View) => void;
}

const DEFAULT_SETTINGS: EngineSettings = {
  depth: 13,
  mpv: 3,
  thresholds: { minCpl: 50 },
};

const DEFAULT_FILTERS: ImportFilters = {
  lichessUser: '',
  lichessMax: 30,
  chesscomUser: '',
  chesscomMonths: 6,
  chesscomMax: 30,
  pgnUsername: '',
  timeClasses: ['blitz', 'rapid'],
  ratedOnly: true,
};

// older persisted settings had {inaccuracy, mistake, blunder} — normalize to the
// current shape so minCpl is never undefined
export function normalizeSettings(s: EngineSettings): EngineSettings {
  const t = (s?.thresholds ?? {}) as Record<string, number | undefined>;
  const minCpl = typeof t.minCpl === 'number' ? t.minCpl : typeof t.inaccuracy === 'number' ? t.inaccuracy : DEFAULT_SETTINGS.thresholds.minCpl;
  return {
    depth: typeof s?.depth === 'number' ? s.depth : DEFAULT_SETTINGS.depth,
    mpv: typeof s?.mpv === 'number' ? s.mpv : DEFAULT_SETTINGS.mpv,
    thresholds: { minCpl },
  };
}

const SESSION_KEY = 'chess-helper-session-v1';

/** Older persisted filters may predate chesscomMax/pgnUsername — fill defaults
 *  so the Chess.com cap can never become NaN. A persisted chesscomMax of 100 was
 *  the accidental v1 default (never deliberately chosen), so it migrates to 30. */
export function normalizeFilters(f: ImportFilters): ImportFilters {
  const rawMax = Number.isFinite(f?.chesscomMax) ? f.chesscomMax : DEFAULT_FILTERS.chesscomMax;
  return {
    lichessUser: f?.lichessUser ?? '',
    lichessMax: Number.isFinite(f?.lichessMax) ? f.lichessMax : DEFAULT_FILTERS.lichessMax,
    chesscomUser: f?.chesscomUser ?? '',
    chesscomMonths: Number.isFinite(f?.chesscomMonths) ? f.chesscomMonths : DEFAULT_FILTERS.chesscomMonths,
    chesscomMax: rawMax === 100 ? DEFAULT_FILTERS.chesscomMax : rawMax,
    pgnUsername: f?.pgnUsername ?? '',
    timeClasses: Array.isArray(f?.timeClasses) ? f.timeClasses : [...DEFAULT_FILTERS.timeClasses],
    ratedOnly: typeof f?.ratedOnly === 'boolean' ? f.ratedOnly : DEFAULT_FILTERS.ratedOnly,
  };
}

function saveSession(t: TrainingSession): void {
  try {
    if (t.active && t.queue.length > 0) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(t));
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
  } catch {
    /* persistence is best-effort */
  }
}

export const useStore = create<AppStore>()(
  persist(
    (set, get) => ({
      view: 'import',
      setView: v => set({ view: v }),

      settings: DEFAULT_SETTINGS,
      setSettings: s => set(state => ({ settings: { ...state.settings, ...s } })),
      filters: DEFAULT_FILTERS,
      setFilters: f => set(state => ({ filters: { ...state.filters, ...f } })),

      games: {},
      analyses: {},
      trainingStats: {},
      dismissed: {},

      hydrate: async () => {
        // normalize settings first (older persisted shapes may lack minCpl)
        const normalized = normalizeSettings(get().settings);
        const normalizedFilters = normalizeFilters(get().filters);
        set({ settings: normalized, filters: normalizedFilters });
        const minCpl = normalized.thresholds.minCpl;
        const [games, analyses, stats, overrides] = await Promise.all([
          dbGetAll<GameRecord>('games'),
          dbGetAll<GameAnalysis>('analyses'),
          dbGetAllEntries<TrainingStats>('training'),
          dbGetAllEntries<LabelDismissal>('overrides'),
        ]);
        const gamesMap: Record<string, GameRecord> = {};
        for (const g of games) gamesMap[g.key] = g;
        const analysesMap: Record<string, GameAnalysis> = {};
        for (const a of analyses) {
          // migrate analyses made with an older classification schema — the
          // stored evals are re-classified locally, no engine needed
          const migrated = a.schema === ANALYSIS_SCHEMA ? a : reclassifyAnalysis(a, minCpl);
          analysesMap[migrated.gameKey] = migrated;
          if (migrated !== a) void dbPut('analyses', migrated.gameKey, migrated);
        }
        const statsMap: Record<string, TrainingStats> = {};
        for (const [posKey, st] of stats) statsMap[posKey] = st;
        const dismissedMap: Record<string, LabelDismissal> = {};
        for (const [posKey, d] of overrides) dismissedMap[posKey] = d;
        set({ games: gamesMap, analyses: analysesMap, trainingStats: statsMap, dismissed: dismissedMap });
        // restore an in-progress session across refreshes
        try {
          const raw = localStorage.getItem(SESSION_KEY);
          if (raw) {
            const saved = JSON.parse(raw) as Partial<TrainingSession>;
            if (saved?.active && Array.isArray(saved.queue) && saved.queue.length > 0) {
              set({
                training: {
                  ...saved,
                  queue: saved.queue,
                  active: true,
                  total: saved.total || saved.queue.length,
                  firstTry: saved.firstTry ?? 0,
                  retried: saved.retried ?? 0,
                  skipped: saved.skipped ?? 0,
                  hintSolved: saved.hintSolved ?? 0,
                  attempts: saved.attempts ?? 0,
                  failsByPos: saved.failsByPos ?? {},
                  categories: saved.categories ?? [],
                  index: saved.index ?? 0,
                },
                view: 'train',
              });
            } else {
              localStorage.removeItem(SESSION_KEY);
            }
          }
        } catch {
          /* corrupted session — ignore */
        }
      },

      addGames: async records => {
        const existing = get().games;
        const fresh: GameRecord[] = [];
        for (const r of records) {
          if (!existing[r.key]) fresh.push(r);
        }
        const merged = { ...existing };
        for (const r of records) merged[r.key] = r;
        await dbBulkPut(
          'games',
          records.map(r => [r.key, r])
        );
        set({ games: merged });
        return fresh.length;
      },

      deleteGame: async key => {
        const games = { ...get().games };
        const analyses = { ...get().analyses };
        delete games[key];
        delete analyses[key];
        set({ games, analyses });
        await dbDelete('games', key);
        await dbDelete('analyses', key);
      },

      importState: { active: false, message: '', error: null },
      setImportState: s => set(state => ({ importState: { ...state.importState, ...s } })),

      job: { active: false, cancelRequested: false, progress: null, error: null, result: null },
      cancelAnalysis: () => set(state => ({ job: { ...state.job, cancelRequested: true } })),

      startAnalysis: async (gameKeys, reanalyzeAll) => {
        if (get().job.active) return; // one analysis job at a time — they share the engine pool
        const pool = await getEnginePool(); // needed for the exact engine identity of the skip check
        const { games, analyses, settings } = get();
        const engineKey = engineKeyOf(pool.name.split(' ×')[0], settings.depth, settings.mpv);
        const all = gameKeys.map(k => games[k]).filter(Boolean);
        // skip games already analyzed by THIS engine at this exact config (and schema)
        const needsWork = (g: GameRecord) => {
          const existing = analyses[g.key];
          return !existing || existing.engineKey !== engineKey;
        };
        const list = reanalyzeAll ? all : all.filter(needsWork);
        const skipped = all.length - list.length;
        if (list.length === 0) {
          set({
            job: {
              active: false,
              cancelRequested: false,
              progress: null,
              error: `Nothing to analyze — all ${all.length} selected games already have an up-to-date analysis at depth ${settings.depth}. Tick "re-analyze" to redo them anyway.`,
              result: null,
            },
          });
          return;
        }
        set({ job: { active: true, cancelRequested: false, progress: null, error: null, result: null } });
        try {
          const result = await analyzeGames({
            games: list,
            depth: settings.depth,
            mpv: settings.mpv,
            minCpl: settings.thresholds.minCpl,
            onProgress: p => set(state => ({ job: { ...state.job, progress: p } })),
            shouldCancel: () => get().job.cancelRequested,
            onGameAnalyzed: async a => {
              await dbPut('analyses', a.gameKey, a);
              set(state => ({ analyses: { ...state.analyses, [a.gameKey]: a } }));
            },
          });
          set(state => ({ job: { ...state.job, active: false, result: { ...result, skipped } } }));
        } catch (e) {
          set({ job: { active: false, cancelRequested: false, progress: null, error: e instanceof Error ? e.message : String(e), result: null } });
        }
      },

      engine: { status: 'unloaded' },
      ensureEngine: async () => {
        if (get().engine.status === 'loading' || get().engine.status === 'ready') return;
        set({ engine: { status: 'loading' } });
        try {
          const pool = await getEnginePool();
          set({ engine: { status: 'ready', name: pool.name } });
        } catch (e) {
          set({ engine: { status: 'error', error: e instanceof Error ? e.message : String(e) } });
        }
      },

      training: {
        queue: [],
        categories: [],
        index: 0,
        total: 0,
        active: false,
        firstTry: 0,
        retried: 0,
        skipped: 0,
        hintSolved: 0,
        attempts: 0,
        failsByPos: {},
      },

      startTraining: (categories, phase, piece) => {
        const { analyses, games, trainingStats, dismissed } = get();
        const { items, categories: cats } = buildTrainingQueue(Object.values(analyses), games, categories, phase, trainingStats, piece, dismissed);
        const session: TrainingSession = {
          queue: items,
          categories: cats,
          index: 0,
          total: items.length,
          active: items.length > 0,
          firstTry: 0,
          retried: 0,
          skipped: 0,
          hintSolved: 0,
          attempts: 0,
          failsByPos: {},
        };
        set({ training: session, view: items.length > 0 ? 'train' : get().view });
        saveSession(session);
      },

      trainPositions: items => {
        if (items.length === 0) return;
        const counts = new Map<Category, number>();
        for (const it of items) counts.set(it.category, (counts.get(it.category) ?? 0) + 1);
        const categories = [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
        const session: TrainingSession = {
          queue: items,
          categories,
          index: 0,
          total: items.length,
          active: true,
          firstTry: 0,
          retried: 0,
          skipped: 0,
          hintSolved: 0,
          attempts: 0,
          failsByPos: {},
        };
        set({ training: session, view: 'train' });
        saveSession(session);
      },

      countAttempt: () => {
        const { training } = get();
        if (!training.active) return;
        const session = { ...training, attempts: training.attempts + 1 };
        set({ training: session });
        saveSession(session);
      },

      /**
       * Commit the current position's result and move to the next one. Called
       * only when the user leaves the position (Next / Skip / Not-a-mistake), so
       * they always review the feedback first. Failed positions are re-queued a
       * few slots later; solving one of THOSE counts as "after retry", never as
       * an immediate solve. Dismissed labels drop out without touching stats.
       */
      commitTraining: async meta => {
        const { training } = get();
        if (!training.active) return;
        const item = training.queue[training.index];
        if (!item) return;

        if (meta.dismissed) {
          const queue = training.queue.filter((_, i) => i !== training.index);
          const session: TrainingSession = { ...training, queue, index: Math.min(training.index, queue.length) };
          set({ training: session });
          saveSession(session);
          await get().dismissLabel(item.posKey, item.category);
          return;
        }

        const correct = meta.correct ?? false;
        const failedBefore = (training.failsByPos[item.posKey] ?? 0) > 0;
        let queue = training.queue;
        let index = training.index;
        if (correct) {
          queue = training.queue.filter((_, i) => i !== training.index);
          index = Math.min(index, queue.length);
        } else {
          queue = [...training.queue];
          const [current] = queue.splice(index, 1);
          const at = Math.min(index + 4, queue.length);
          queue.splice(at, 0, current);
        }
        try {
          const prev = await dbGet<TrainingStats>('training', item.posKey);
          const stats: TrainingStats = {
            attempts: (prev?.attempts ?? 0) + 1,
            correct: (prev?.correct ?? 0) + (correct ? 1 : 0),
            lastResult: correct ? 'correct' : 'wrong',
            lastAt: Date.now(),
          };
          await dbPut('training', item.posKey, stats);
          const statsMap = { ...get().trainingStats, [item.posKey]: stats };
          set({ trainingStats: statsMap });
        } catch {
          /* stats are best-effort */
        }
        const failsByPos = { ...training.failsByPos };
        if (!correct) failsByPos[item.posKey] = (failsByPos[item.posKey] ?? 0) + 1;
        const session: TrainingSession = {
          ...training,
          queue,
          index,
          failsByPos,
          firstTry: training.firstTry + (correct && !failedBefore ? 1 : 0),
          retried: training.retried + (correct && failedBefore ? 1 : 0),
          skipped: training.skipped + (meta.skipped ? 1 : 0),
          hintSolved: training.hintSolved + (correct && meta.hintUsed ? 1 : 0),
        };
        set({ training: session });
        saveSession(session);
      },

      skipTraining: () => {
        void get().commitTraining({ correct: false, skipped: true });
      },

      dismissLabel: async (posKey, label) => {
        const d: LabelDismissal = { label, at: Date.now() };
        await dbPut('overrides', posKey, d);
        set({ dismissed: { ...get().dismissed, [posKey]: d } });
      },

      restoreLabels: async () => {
        await dbClear('overrides');
        set({ dismissed: {} });
      },

      endTraining: goTo => {
        const session: TrainingSession = {
          queue: [],
          categories: [],
          index: 0,
          total: 0,
          active: false,
          firstTry: 0,
          retried: 0,
          skipped: 0,
          hintSolved: 0,
          attempts: 0,
          failsByPos: {},
        };
        set({ training: session, ...(goTo ? { view: goTo } : {}) });
        saveSession(session);
      },
    }),
    {
      name: 'chess-helper-settings',
      partialize: s => ({ settings: s.settings, filters: s.filters }),
    }
  )
);

// dev-only hook for debugging/automated testing (guarded: no window in node tests)
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__store = useStore;
}
