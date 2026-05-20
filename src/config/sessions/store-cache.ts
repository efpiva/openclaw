import { createExpiringMapCache, isCacheEnabled, resolveCacheTtlMs } from "../cache-utils.js";
import type { SessionEntry } from "./types.js";

type SessionStoreCacheEntry = {
  store: Record<string, SessionEntry>;
  mtimeMs?: number;
  sizeBytes?: number;
  serialized?: string;
};

const DEFAULT_SESSION_STORE_TTL_MS = 45_000; // 45 seconds (between 30-60s)
const LARGE_SESSION_STORE_STRING_MIN_CHARS = 512;
const LARGE_SESSION_STORE_STRING_MAX_INTERNED = 256;

const SESSION_STORE_CACHE = createExpiringMapCache<string, SessionStoreCacheEntry>({
  ttlMs: getSessionStoreTtl,
});
const SESSION_STORE_SERIALIZED_CACHE = new Map<string, string>();
const SESSION_STORE_STRING_INTERN_POOL = new Map<string, string>();
const SESSION_STORE_STRING_INTERN_STATS = {
  stored: 0,
  reused: 0,
  skippedSmall: 0,
  skippedFull: 0,
};

function resetSessionStoreStringInternStats(): void {
  SESSION_STORE_STRING_INTERN_STATS.stored = 0;
  SESSION_STORE_STRING_INTERN_STATS.reused = 0;
  SESSION_STORE_STRING_INTERN_STATS.skippedSmall = 0;
  SESSION_STORE_STRING_INTERN_STATS.skippedFull = 0;
}

function internLargeSessionStoreString(value: string): string {
  if (value.length < LARGE_SESSION_STORE_STRING_MIN_CHARS) {
    SESSION_STORE_STRING_INTERN_STATS.skippedSmall += 1;
    return value;
  }
  const interned = SESSION_STORE_STRING_INTERN_POOL.get(value);
  if (interned !== undefined) {
    SESSION_STORE_STRING_INTERN_STATS.reused += 1;
    return interned;
  }
  if (SESSION_STORE_STRING_INTERN_POOL.size >= LARGE_SESSION_STORE_STRING_MAX_INTERNED) {
    SESSION_STORE_STRING_INTERN_STATS.skippedFull += 1;
    return value;
  }
  SESSION_STORE_STRING_INTERN_POOL.set(value, value);
  SESSION_STORE_STRING_INTERN_STATS.stored += 1;
  return value;
}

export function internSessionEntryLargeStrings(entry: SessionEntry): void {
  const snapshot = entry.skillsSnapshot;
  if (!snapshot?.prompt) {
    return;
  }
  // The live session store repeatedly clones a small set of large skills prompts.
  // Intern only that known high-duplication field so behavior and serialization stay unchanged.
  snapshot.prompt = internLargeSessionStoreString(snapshot.prompt);
}

export function internSessionStoreLargeStrings(store: Record<string, SessionEntry>): void {
  for (const entry of Object.values(store)) {
    internSessionEntryLargeStrings(entry);
  }
}

export function getSessionStoreStringInternStatsForTest(): {
  poolSize: number;
  stored: number;
  reused: number;
  skippedSmall: number;
  skippedFull: number;
  minChars: number;
  maxEntries: number;
} {
  return {
    poolSize: SESSION_STORE_STRING_INTERN_POOL.size,
    stored: SESSION_STORE_STRING_INTERN_STATS.stored,
    reused: SESSION_STORE_STRING_INTERN_STATS.reused,
    skippedSmall: SESSION_STORE_STRING_INTERN_STATS.skippedSmall,
    skippedFull: SESSION_STORE_STRING_INTERN_STATS.skippedFull,
    minChars: LARGE_SESSION_STORE_STRING_MIN_CHARS,
    maxEntries: LARGE_SESSION_STORE_STRING_MAX_INTERNED,
  };
}

export function cloneSessionStoreRecord(
  store: Record<string, SessionEntry>,
  serialized?: string,
): Record<string, SessionEntry> {
  const cloned = JSON.parse(serialized ?? JSON.stringify(store)) as Record<string, SessionEntry>;
  internSessionStoreLargeStrings(cloned);
  return cloned;
}

export function getSessionStoreTtl(): number {
  return resolveCacheTtlMs({
    envValue: process.env.OPENCLAW_SESSION_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_SESSION_STORE_TTL_MS,
  });
}

export function isSessionStoreCacheEnabled(): boolean {
  return isCacheEnabled(getSessionStoreTtl());
}

export function clearSessionStoreCaches(): void {
  SESSION_STORE_CACHE.clear();
  SESSION_STORE_SERIALIZED_CACHE.clear();
  SESSION_STORE_STRING_INTERN_POOL.clear();
  resetSessionStoreStringInternStats();
}

export function invalidateSessionStoreCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
  SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
}

export function getSerializedSessionStore(storePath: string): string | undefined {
  return SESSION_STORE_SERIALIZED_CACHE.get(storePath);
}

export function setSerializedSessionStore(storePath: string, serialized?: string): void {
  if (serialized === undefined) {
    SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
    return;
  }
  SESSION_STORE_SERIALIZED_CACHE.set(storePath, serialized);
}

export function dropSessionStoreObjectCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
}

export function readSessionStoreCache(params: {
  storePath: string;
  mtimeMs?: number;
  sizeBytes?: number;
  clone?: boolean;
}): Record<string, SessionEntry> | null {
  const cached = SESSION_STORE_CACHE.get(params.storePath);
  if (!cached) {
    return null;
  }
  if (params.mtimeMs !== cached.mtimeMs || params.sizeBytes !== cached.sizeBytes) {
    invalidateSessionStoreCache(params.storePath);
    return null;
  }
  if (params.clone === false) {
    return cached.store;
  }
  return cloneSessionStoreRecord(cached.store, cached.serialized);
}

export function takeMutableSessionStoreCache(params: {
  storePath: string;
  mtimeMs?: number;
  sizeBytes?: number;
}): Record<string, SessionEntry> | null {
  const cached = SESSION_STORE_CACHE.get(params.storePath);
  if (!cached) {
    return null;
  }
  if (params.mtimeMs !== cached.mtimeMs || params.sizeBytes !== cached.sizeBytes) {
    invalidateSessionStoreCache(params.storePath);
    return null;
  }
  SESSION_STORE_CACHE.delete(params.storePath);
  return cached.store;
}

export function writeSessionStoreCache(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  mtimeMs?: number;
  sizeBytes?: number;
  serialized?: string;
}): void {
  const store =
    params.serialized === undefined ? cloneSessionStoreRecord(params.store) : params.store;
  if (params.serialized !== undefined) {
    internSessionStoreLargeStrings(store);
  }
  SESSION_STORE_CACHE.set(params.storePath, {
    store,
    mtimeMs: params.mtimeMs,
    sizeBytes: params.sizeBytes,
    serialized: params.serialized,
  });
  if (params.serialized !== undefined) {
    SESSION_STORE_SERIALIZED_CACHE.set(params.storePath, params.serialized);
  }
}
