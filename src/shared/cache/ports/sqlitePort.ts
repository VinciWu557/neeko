/**
 * SQLite-backed `PersistentCachePort`.
 *
 * Thin adapter only: it forwards to the Tauri commands and owns the
 * `namespace`. The generic store deliberately knows nothing about namespaces —
 * partition is a storage-backend concept, and the file backend would not need
 * one at all.
 *
 * ## Why `load()` is a two-step read
 *
 * The Rust side exposes `get_many(namespace, keys, version)` rather than "dump
 * the whole namespace", because an unbounded read would violate the 2MB IPC
 * boundary (red line 4). But the KV layer is addressed by key: a fresh process
 * has no idea which keys exist, so it cannot ask for them without first
 * learning the key set. `cache_list_keys` answers exactly that — keys only, no
 * values, bounded by `maxEntries` — and the values then follow through
 * `cache_get_many`.
 *
 * The first version tracked keys in memory (`knownKeys`) and simply never asked
 * the backend; that made the cache process-local, so "restart the app and stop
 * paying for the same translations" silently did not work. Reverting to a key
 * list is what makes persistence real.
 */

import {
  cacheClear,
  cacheDeleteMany,
  cacheEvict,
  cacheGetMany,
  cacheListKeys,
  cachePutMany,
} from '../api/cacheApi';
import type { CacheSnapshot, PersistentCachePort } from '../persistentKeyValueStore';

export interface SqliteCachePortOptions {
  /** Cache domain, validated on the Rust side (`[a-z0-9._-]`, ≤ 64 chars). */
  namespace: string;
  /** Payload version, recorded with every write and required on every read. */
  version: number;
  /**
   * Max entries to keep. Also bounds the key enumeration, so `load()` can never
   * request more rows than the store is allowed to hold.
   */
  maxEntries?: number;
}

/** Fallback cap when the caller does not configure one; matches the store. */
const DEFAULT_MAX_ENTRIES = 5000;

/**
 * Create a port bound to `namespace`.
 *
 * @param options namespace + version + optional cap
 */
export function createSqliteCachePort(options: SqliteCachePortOptions): PersistentCachePort {
  const { namespace, version, maxEntries } = options;
  const limit = maxEntries ?? DEFAULT_MAX_ENTRIES;

  return {
    async load(): Promise<CacheSnapshot<unknown> | null> {
      const keys = await cacheListKeys(namespace, version, limit);
      if (keys.length === 0) return null;

      const rows = await cacheGetMany(namespace, keys, version);
      if (rows.length === 0) return null;

      const entries: Record<string, unknown> = {};
      const corrupt: string[] = [];
      for (const [key, raw] of rows) {
        try {
          entries[key] = JSON.parse(raw);
        } catch {
          // A corrupt row must drop only itself, and it must also stop being
          // served: the store cannot evict it, so the port removes the row.
          corrupt.push(key);
        }
      }
      if (corrupt.length > 0) {
        // Best-effort: a failed cleanup must not fail the whole load.
        try {
          await cacheDeleteMany(namespace, corrupt);
        } catch {
          /* leave it; the next load will try again */
        }
      }
      return { version, entries };
    },

    async putMany(entries): Promise<void> {
      if (entries.length === 0) return;
      const payload = entries.map(
        ([key, value]) => [key, JSON.stringify(value)] as [string, string],
      );
      await cachePutMany(namespace, payload, version);
      if (maxEntries !== undefined) {
        // Caps the table even when rows belong to a retired payload version
        // (those are unreachable through reads but still occupy space).
        await cacheEvict(namespace, maxEntries);
      }
    },

    async deleteMany(keys): Promise<void> {
      if (keys.length === 0) return;
      await cacheDeleteMany(namespace, keys);
    },
  };
}

/** Drop an entire namespace (used when a payload version is retired). */
export function clearSqliteCacheNamespace(namespace: string): Promise<number> {
  return cacheClear(namespace);
}
