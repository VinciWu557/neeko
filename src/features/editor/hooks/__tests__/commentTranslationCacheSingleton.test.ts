/**
 * 注释翻译共享缓存的测试。
 *
 * 两件事必须钉住，都是实现过程中真实出过问题的地方：
 *
 * 1. **跨进程语义**：第二个 store 实例（= 重启后的第一次访问）必须能读到第一个
 *    写入的条目。第一版 Port 把已写键记在内存 `knownKeys` 里，新进程的键集为空，
 *    于是 `load()` 直接返回 null —— 「持久化」实际是进程内的。
 * 2. **生产接线本身**：`getSharedCommentCache()` 在 Tauri 环境下必须返回持久化实现，
 *    且它的 `set` 之后数据真的落盘（`set` 不 await 时 flush 会先跑，写入静默丢失）。
 *    这条不能用「手搭一个 PersistentKeyValueStore」代替 —— 那样测的是通用层，
 *    而通用层已经有自己的 16+ 条用例。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PersistentKeyValueStore } from '@/shared/cache';

import { MemoryCache, type CachedTranslation } from '../../comment/translationCache';

const table = new Map<string, string>();

vi.mock('@/shared/cache/api/cacheApi', () => ({
  cacheListKeys: vi.fn(async () => [...table.keys()]),
  cacheGetMany: vi.fn(async (_ns: string, keys: string[]) =>
    keys.filter((k) => table.has(k)).map((k) => [k, table.get(k)!] as [string, string]),
  ),
  cachePutMany: vi.fn(async (_ns: string, entries: [string, string][]) => {
    for (const [k, v] of entries) table.set(k, v);
  }),
  cacheDeleteMany: vi.fn(async (_ns: string, keys: string[]) => {
    for (const k of keys) table.delete(k);
    return keys.length;
  }),
  cacheEvict: vi.fn(async () => 0),
  cacheClear: vi.fn(async () => 0),
}));

const validate = (raw: unknown): CachedTranslation | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.source !== 'string' || typeof e.text !== 'string') return null;
  if (typeof e.at !== 'number') return null;
  return { source: e.source, text: e.text, at: e.at };
};

/** 只构造一次：两次 `Date.now()` 会被毫秒边界切开（`pnpm check` 并行时实测）。 */
const entry = (text: string): CachedTranslation => ({ source: 'src', text, at: 1_700_000_000_000 });

beforeEach(() => {
  table.clear();
  // 让单例走「Tauri 运行时」分支：被测的正是持久化接线。
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
});

afterEach(async () => {
  const singleton = await import('../commentTranslationCacheSingleton');
  singleton.__setSharedCommentCacheForTests(null);
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

describe('shared comment cache / 持久化接线', () => {
  it('should return a cache that persists across store instances', async () => {
    const singleton = await import('../commentTranslationCacheSingleton');
    singleton.__setSharedCommentCacheForTests(null);
    const cache = await singleton.getSharedCommentCache();

    const value = entry('译文一');
    await cache.set('k', value);

    // 新实例 = 重启后的第一次访问，只能靠后端里的数据命中。
    const store = new PersistentKeyValueStore<CachedTranslation>({
      port: (await import('@/shared/cache')).createSqliteCachePort({
        namespace: 'comment-i18n',
        version: 1,
      }),
      version: 1,
      validate,
    });
    expect(await store.get('k')).toEqual(value);
  });

  it('should write through on set, not only on a later flush', async () => {
    // 回归：`toTranslationCache.set` 若不 await `store.set`，flush 会先跑，
    // 脏标记在之后才置上，于是这一批**永远不落盘**（putMany 调用 0 次）。
    const singleton = await import('../commentTranslationCacheSingleton');
    singleton.__setSharedCommentCacheForTests(null);
    const cache = await singleton.getSharedCommentCache();

    await cache.set('k', entry('v'));

    // `set() 返回后数据必须已经落盘` —— 描述写成注释，因为 vitest/valid-expect
    // 不允许 expect 的第二参数（那是 jest 的写法，Vitest 会忽略它，写上去只是误导）。
    expect(table.has('k')).toBe(true);
  });

  it('should still expose the shared instance across calls', async () => {
    const singleton = await import('../commentTranslationCacheSingleton');
    singleton.__setSharedCommentCacheForTests(null);

    const a = await singleton.getSharedCommentCache();
    const b = await singleton.getSharedCommentCache();

    expect(a).toBe(b);
  });

  it('should fall back to the in-memory cache outside Tauri', async () => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
    const singleton = await import('../commentTranslationCacheSingleton');
    singleton.__setSharedCommentCacheForTests(null);

    expect(await singleton.getSharedCommentCache()).toBeInstanceOf(MemoryCache);
  });
});

describe('MemoryCache (test double)', () => {
  it('should still satisfy the TranslationCache contract', async () => {
    const cache = new MemoryCache();
    const value = entry('memory');
    await cache.set('k', value);

    expect(await cache.get('k')).toEqual(value);
    expect((await cache.getMany(['k'])).size).toBe(1);
  });
});

describe('profileVersionNumber 契约', () => {
  /**
   * The profile string and the numeric version must never drift.
   *
   * If the profile stops ending in a number, every version collapses to the
   * fallback — meaning "I tightened the validation rules" silently keeps
   * serving translations produced under the old rules. There is no error, no
   * log the user sees, just new rules that appear not to work.
   */
  it('should parse the real COMMENT_TRANSLATION_PROFILE', async () => {
    const { profileVersionNumber } = await import('../commentTranslationCacheSingleton');
    const version = profileVersionNumber();
    expect(Number.isInteger(version)).toBe(true);
    expect(version).toBeGreaterThan(0);
  });

  /**
   * Guard the guard: the parse must actually depend on the digits, otherwise
   * the assertion above would pass for any constant.
   */
  it('should derive the version from the profile digits, not a constant', async () => {
    const { profileVersionNumber } = await import('../commentTranslationCacheSingleton');
    const real = (await import('../../comment/translationCache')).COMMENT_TRANSLATION_PROFILE;
    const digits = /(\d+)$/.exec(real)?.[1];
    if (!digits) {
      throw new Error(`profile ${real} must end in a decimal number`);
    }
    expect(profileVersionNumber()).toBe(Number.parseInt(digits, 10));
  });
});
