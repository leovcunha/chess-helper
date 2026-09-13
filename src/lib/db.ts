// Minimal promise wrapper around IndexedDB. Stores:
//  - games:     GameRecord, key = gameKey
//  - analyses:  GameAnalysis, key = `${gameKey}|${engineKey}`
//  - training:  TrainingStats, key = posKey
const DB_NAME = 'chess-helper';
const DB_VERSION = 2;
const STORES = ['games', 'analyses', 'training', 'overrides'] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    db =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`${store} request failed`));
      })
  );
}

export async function dbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  return tx<T>(store, 'readonly', s => s.get(key));
}

export async function dbGetAll<T>(store: StoreName): Promise<T[]> {
  return tx<T[]>(store, 'readonly', s => s.getAll());
}

/** getAll + keys — needed when the key itself is meaningful (e.g. posKey). */
export async function dbGetAllEntries<T>(store: StoreName): Promise<[string, T][]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const out: [string, T][] = [];
    const t = db.transaction(store, 'readonly');
    const req = t.objectStore(store).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        out.push([String(cursor.key), cursor.value as T]);
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error ?? new Error(`${store} cursor failed`));
  });
}

export async function dbPut(store: StoreName, key: string, value: unknown): Promise<void> {
  await tx(store, 'readwrite', s => s.put(value, key));
}

export async function dbDelete(store: StoreName, key: string): Promise<void> {
  await tx(store, 'readwrite', s => s.delete(key));
}

export async function dbBulkPut(store: StoreName, entries: [string, unknown][]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const [key, value] of entries) s.put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error(`${store} bulkPut failed`));
  });
}

export async function dbClear(store: StoreName): Promise<void> {
  await tx(store, 'readwrite', s => s.clear());
}
