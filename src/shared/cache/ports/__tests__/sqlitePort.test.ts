/**
 * Tests for the SQLite port adapter.
 *
 * The commands are stubbed at the module boundary: this file tests forwarding,
 * payload shape and cross-process reads, not the Rust store (which has its own
 * suite). Two things are worth pinning here because both were silently broken:
 *
 * 1. the namespace travels with every call (dropping it points every consumer
 *    at one shared cache);
 * 2. `load()` enumerates the backend instead of replaying an in-memory key set
 *    (a first version did the latter, which made persistence process-local).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cacheGetMany, cacheListKeys, cachePutMany, cacheDeleteMany, cacheEvict, cacheClear } =
  vi.hoisted(() => ({
    cacheGetMany: vi.fn(),
    cacheListKeys: vi.fn(),
    cachePutMany: vi.fn(),
    cacheDeleteMany: vi.fn(),
    cacheEvict: vi.fn(),
    cacheClear: vi.fn(),
  }));

vi.mock('../../api/cacheApi', () => ({
  cacheGetMany,
  cacheListKeys,
  cachePutMany,
  cacheDeleteMany,
  cacheEvict,
  cacheClear,
}));

const { createSqliteCachePort, clearSqliteCacheNamespace } = await import('../sqlitePort');

beforeEach(() => {
  cacheGetMany.mockReset().mockResolvedValue([]);
  cacheListKeys.mockReset().mockResolvedValue([]);
  cachePutMany.mockReset().mockResolvedValue(undefined);
  cacheDeleteMany.mockReset().mockResolvedValue(0);
  cacheEvict.mockReset().mockResolvedValue(0);
  cacheClear.mockReset().mockResolvedValue(0);
});

describe('createSqliteCachePort', () => {
  it('should send the namespace and version with every write', async () => {
    const port = createSqliteCachePort({ namespace: 'comment-i18n', version: 3 });

    await port.putMany([['k', { text: 'hi' }]]);

    expect(cachePutMany).toHaveBeenCalledWith('comment-i18n', [['k', '{"text":"hi"}']], 3);
  });

  it('should send the namespace and version with every read', async () => {
    const port = createSqliteCachePort({ namespace: 'doc-i18n', version: 4 });
    cacheListKeys.mockResolvedValue(['a']);
    cacheGetMany.mockResolvedValue([['a', '1']]);

    await port.load();

    expect(cacheListKeys).toHaveBeenCalledWith('doc-i18n', 4, 5000);
    expect(cacheGetMany).toHaveBeenCalledWith('doc-i18n', ['a'], 4);
  });

  it('should enumerate the backend rather than replaying an in-memory key set', async () => {
    // Regression: the first implementation remembered written keys in a Set, so
    // a *fresh process* asked for nothing and got nothing — the cache was
    // process-local while claiming to be persistent.
    const writer = createSqliteCachePort({ namespace: 'ns', version: 1 });
    await writer.putMany([['k', 'v']]);

    cacheListKeys.mockResolvedValue(['k']);
    cacheGetMany.mockResolvedValue([['k', '"v"']]);
    const freshProcess = createSqliteCachePort({ namespace: 'ns', version: 1 });

    expect(await freshProcess.load()).toEqual({ version: 1, entries: { k: 'v' } });
    expect(cacheListKeys).toHaveBeenCalledTimes(1);
  });

  it('should return null when the backend has no keys', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 1 });
    expect(await port.load()).toBeNull();
    expect(cacheGetMany).not.toHaveBeenCalled();
  });

  it('should decode stored JSON back into values', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 7 });
    cacheListKeys.mockResolvedValue(['a', 'b']);
    cacheGetMany.mockResolvedValue([
      ['a', '{"n":1}'],
      ['b', '[1,2]'],
    ]);

    const snapshot = await port.load();

    expect(snapshot).toEqual({ version: 7, entries: { a: { n: 1 }, b: [1, 2] } });
  });

  it('should drop a corrupt row and delete it from the backend', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 1 });
    cacheListKeys.mockResolvedValue(['good', 'bad']);
    cacheGetMany.mockResolvedValue([
      ['good', '"value"'],
      ['bad', '{not json'],
    ]);

    const snapshot = await port.load();

    expect(snapshot?.entries).toEqual({ good: 'value' });
    expect(cacheDeleteMany).toHaveBeenCalledWith('ns', ['bad']);
  });

  it('should not fail the load when the corrupt-row cleanup fails', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 1 });
    cacheListKeys.mockResolvedValue(['good', 'bad']);
    cacheGetMany.mockResolvedValue([
      ['good', '"value"'],
      ['bad', '{not json'],
    ]);
    cacheDeleteMany.mockRejectedValue(new Error('backend down'));

    const snapshot = await port.load();

    expect(snapshot?.entries).toEqual({ good: 'value' });
  });

  it('should delete evicted keys in the backend instead of only forgetting them', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 1 });

    await port.deleteMany(['a', 'b']);

    expect(cacheDeleteMany).toHaveBeenCalledWith('ns', ['a', 'b']);
  });

  it('should not call the backend for an empty delete', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 1 });
    await port.deleteMany([]);
    expect(cacheDeleteMany).not.toHaveBeenCalled();
  });

  it('should enforce maxEntries after a write when configured', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 1, maxEntries: 50 });

    await port.putMany([['k', 'v']]);

    expect(cacheEvict).toHaveBeenCalledWith('ns', 50);
  });

  it('should not evict when no cap is configured', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 1 });

    await port.putMany([['k', 'v']]);

    expect(cacheEvict).not.toHaveBeenCalled();
  });

  it('should not call the backend for an empty write', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 1 });
    await port.putMany([]);
    expect(cachePutMany).not.toHaveBeenCalled();
  });

  it('should propagate a backend failure so the store can keep its dirty flag', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 1 });
    cachePutMany.mockRejectedValue(new Error('disk full'));

    await expect(port.putMany([['k', 'v']])).rejects.toThrow('disk full');
  });
});

describe('clearSqliteCacheNamespace', () => {
  it('should forward the namespace', async () => {
    await clearSqliteCacheNamespace('comment-i18n');
    expect(cacheClear).toHaveBeenCalledWith('comment-i18n');
  });
});
