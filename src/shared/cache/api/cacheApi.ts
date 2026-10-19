/**
 * IPC wrappers for the generic cache commands.
 *
 * Red line: `invoke` lives only in `api/` files. Everything else calls the
 * functions below, so a command rename touches one file.
 *
 * This is a shared-layer IPC entry, like `shared/utils/errorReporting.ts`: the
 * generic cache has no feature directory to host it, because it is not owned
 * by one feature.
 */

// eslint-disable-next-line no-restricted-imports -- shared IPC entry for the generic cache
import { invoke } from '@tauri-apps/api/core';

/** Read the cached values for `keys` at `version`; unknown keys are absent. */
export function cacheGetMany(
  namespace: string,
  keys: readonly string[],
  version: number,
): Promise<Array<[string, string]>> {
  return invoke<Array<[string, string]>>('cache_get_many', {
    namespace,
    keys: [...keys],
    version,
  });
}

/** List the keys stored in `namespace` at `version` (keys only, never values). */
export function cacheListKeys(
  namespace: string,
  version: number,
  limit: number,
): Promise<string[]> {
  return invoke<string[]>('cache_list_keys', { namespace, version, limit });
}

/** Write `entries` in one transaction. */
export function cachePutMany(
  namespace: string,
  entries: ReadonlyArray<readonly [string, string]>,
  version: number,
): Promise<void> {
  return invoke('cache_put_many', { namespace, entries, version });
}

/** Delete specific keys in `namespace`. */
export function cacheDeleteMany(namespace: string, keys: readonly string[]): Promise<number> {
  return invoke<number>('cache_delete_many', { namespace, keys: [...keys] });
}

/** Keep only the `keep` newest entries in `namespace`. */
export function cacheEvict(namespace: string, keep: number): Promise<number> {
  return invoke<number>('cache_evict', { namespace, keep });
}

/** Drop every entry in `namespace`. */
export function cacheClear(namespace: string): Promise<number> {
  return invoke<number>('cache_clear', { namespace });
}
