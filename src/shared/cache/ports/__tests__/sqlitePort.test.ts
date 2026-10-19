/**
 * Tests for the SQLite port adapter.
 *
 * The commands are stubbed at the module boundary: this file tests forwarding
 * and payload shape, not the Rust store (which has its own suite). What is
 * worth pinning here is that the namespace actually travels with every call —
 * dropping it would silently point every consumer at one shared cache.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cacheGetMany, cachePutMany, cacheEvict, cacheClear } = vi.hoisted(() => ({
  cacheGetMany: vi.fn(),
  cachePutMany: vi.fn(),
  cacheEvict: vi.fn(),
  cacheClear: vi.fn(),
}));

vi.mock('../../api/cacheApi', () => ({
  cacheGetMany,
  cachePutMany,
  cacheEvict,
  cacheClear,
}));

const { createSqliteCachePort, clearSqliteCacheNamespace } = await import('../sqlitePort');

beforeEach(() => {
  cacheGetMany.mockReset().mockResolvedValue([]);
  cachePutMany.mockReset().mockResolvedValue(undefined);
  cacheEvict.mockReset().mockResolvedValue(0);
  cacheClear.mockReset().mockResolvedValue(0);
});

describe('createSqliteCachePort', () => {
  it('sends the namespace with every write', async () => {
    const port = createSqliteCachePort({ namespace: 'comment-i18n', version: 3 });

    await port.putMany([['k', { text: 'hi' }]]);

    expect(cachePutMany).toHaveBeenCalledWith('comment-i18n', [['k', '{"text":"hi"}']], 3);
  });

  it('sends the namespace with every read', async () => {
    const port = createSqliteCachePort({ namespace: 'doc-i18n', version: 1 });
    await port.putMany([['a', 1]]);
    cacheGetMany.mockResolvedValue([['a', '1']]);

    await port.load();

    expect(cacheGetMany).toHaveBeenCalledWith('doc-i18n', ['a']);
  });

  it('returns null when nothing has been written', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 1 });
    expect(await port.load()).toBeNull();
    expect(cacheGetMany).not.toHaveBeenCalled();
  });

  it('decodes stored JSON back into values', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 7 });
    await port.putMany([
      ['a', { n: 1 }],
      ['b', [1, 2]],
    ]);
    cacheGetMany.mockResolvedValue([
      ['a', '{"n":1}'],
      ['b', '[1,2]'],
    ]);

    const snapshot = await port.load();

    expect(snapshot).toEqual({ version: 7, entries: { a: { n: 1 }, b: [1, 2] } });
  });

  it('drops a corrupt row instead of failing the whole load', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 1 });
    await port.putMany([
      ['good', 'value'],
      ['bad', 'value'],
    ]);
    cacheGetMany.mockResolvedValue([
      ['good', '"value"'],
      ['bad', '{not json'],
    ]);

    const snapshot = await port.load();

    expect(snapshot?.entries).toEqual({ good: 'value' });
  });

  it('stops asking for a key after its row turned out corrupt', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 1 });
    await port.putMany([['bad', 'value']]);
    cacheGetMany.mockResolvedValue([['bad', 'nope']]);

    expect((await port.load())?.entries).toEqual({});

    await port.load();
    // Only the first load asked; the key was dropped.
    expect(cacheGetMany).toHaveBeenCalledTimes(1);
  });

  it('enforces maxEntries after a write when configured', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 1, maxEntries: 50 });

    await port.putMany([['k', 'v']]);

    expect(cacheEvict).toHaveBeenCalledWith('ns', 50);
  });

  it('does not evict when no cap is configured', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 1 });

    await port.putMany([['k', 'v']]);

    expect(cacheEvict).not.toHaveBeenCalled();
  });

  it('does not call the backend for an empty write', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 1 });
    await port.putMany([]);
    expect(cachePutMany).not.toHaveBeenCalled();
  });

  it('propagates a backend failure so the store can keep its dirty flag', async () => {
    const port = createSqliteCachePort({ namespace: 'ns', version: 1 });
    cachePutMany.mockRejectedValue(new Error('disk full'));

    await expect(port.putMany([['k', 'v']])).rejects.toThrow('disk full');
  });
});

describe('clearSqliteCacheNamespace', () => {
  it('forwards the namespace', async () => {
    await clearSqliteCacheNamespace('comment-i18n');
    expect(cacheClear).toHaveBeenCalledWith('comment-i18n');
  });
});
