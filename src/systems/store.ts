// src/systems/store.ts
// Local persistence for scheduler state (README §12: IndexedDB). Falls back to
// an in-memory copy if IndexedDB is unavailable (private mode, older browsers).

import type { SchedulerState } from './scheduler';

const DB_NAME = 'recall-store';
const STORE_NAME = 'state';
const KEY = 'progress';

let memoryFallback: SchedulerState | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('store: IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('store: open failed'));
  });
}

export async function loadProgress(): Promise<SchedulerState | null> {
  try {
    const db = await openDb();
    return await new Promise<SchedulerState | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(KEY);
      req.onsuccess = () => resolve((req.result as SchedulerState) ?? null);
      req.onerror = () => reject(req.error ?? new Error('store: read failed'));
    });
  } catch {
    return memoryFallback;
  }
}

export async function saveProgress(state: SchedulerState): Promise<void> {
  memoryFallback = state;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(state, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('store: write failed'));
    });
  } catch {
    // Memory fallback already updated; offline demo keeps working.
  }
}
