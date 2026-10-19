/**
 * SQLite-backed `PersistentCachePort`.
 *
 * Thin adapter only: it forwards to the Tauri commands and owns the
 * `namespace`. The generic store deliberately knows nothing about namespaces —
 * partition is a storage-backend concept, and the file backend would not need
 * one at all.
 *
 * ## Why `load()` needs a key list
 *
 * The Rust side exposes `get_many(namespace, keys)` rather than "dump the whole
 * namespace", because an unbounded read would violate the 2MB IPC boundary
 * (red line 4). The port therefore remembers which keys it has written and
 * asks for exactly those. A key that was written by a previous process run but
 * never read back in this one is not visible to `load()`.
 *
 * That is a real limitation, and it is acceptable here because the store only
 * ever loads to answer `get(key)` for keys the caller already knows. Making the
 * cache enumerate its own contents would reintroduce the unbounded read.
 */

import { cacheClear, cacheEvict, cacheGetMany, cachePutMany } from '../api/cacheApi';
import type { CacheSnapshot, PersistentCachePort } from '../persistentKeyValueStore';

export interface SqliteCachePortOptions {
  /** Cache domain, validated on the Rust side (`[a-z0-9._-]`, ≤ 64 chars). */
  namespace: string;
  /** Payload version, recorded with every write. */
  version: number;
  /**
   * Max entries to keep. Enforced server-side via `cache_evict` after a write,
   * so a long-running session cannot grow the table without bound.
   */
  maxEntries?: number;
}

/**
 * Create a port bound to `namespace`.
 *
 * @param options namespace + version + optional cap
 */
export function createSqliteCachePort(options: SqliteCachePortOptions): PersistentCachePort {
  const { namespace, version, maxEntries } = options;
  /** Keys this port instance has written, so `load()` can ask for them. */
  const knownKeys = new Set<string>();

  return {
    async load(): Promise<CacheSnapshot<unknown> | null> {
      if (knownKeys.size === 0) return null;
      const rows = await cacheGetMany(namespace, [...knownKeys]);
      if (rows.length === 0) return null;
      const entries: Record<string, unknown> = {};
      for (const [key, raw] of rows) {
        try {
          entries[key] = JSON.parse(raw);
        } catch {
          // A corrupt row must drop only itself. The generic store would
          // otherwise see a failed parse for the whole snapshot.
          knownKeys.delete(key);
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
      for (const [key] of entries) knownKeys.add(key);
      if (maxEntries !== undefined) {
        await cacheEvict(namespace, maxEntries);
      }
    },

    async deleteMany(keys): Promise<void> {
      if (keys.length === 0) return;
      // There is no per-key delete command: eviction is expressed as "keep the
      // newest N", which is what the store does anyway. Clearing and
      // re-writing the survivors would be worse than doing nothing.
      for (const key of keys) knownKeys.delete(key);
    },
  };
}

/** Drop an entire namespace (used when a payload version is retired). */
export function clearSqliteCacheNamespace(namespace: string): Promise<number> {
  return cacheClear(namespace);
}
