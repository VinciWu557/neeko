/**
 * Generic persistent key-value cache.
 *
 * Consumers pick a port (`sqlitePort` for durability across runs) and inject
 * their own entry type plus validator. Nothing here knows what is cached.
 */

export {
  PersistentKeyValueStore,
  type CacheSnapshot,
  type PersistentCacheEntry,
  type PersistentCachePort,
  type PersistentKeyValueStoreOptions,
} from './persistentKeyValueStore';

export { createSqliteCachePort, clearSqliteCacheNamespace } from './ports/sqlitePort';
export type { SqliteCachePortOptions } from './ports/sqlitePort';
