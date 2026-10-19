// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { cacheKey, MemoryCache } from '../translationCache';

/**
 * AC12 / AC13：缓存是**增量能力的唯一来源**。
 *
 * 缓存键必须含 `profileVersion`：改 prompt 或加强校验后，旧条目若继续命中会**遮蔽**新规则
 * —— 表现为「改了规则但线上行为没变」，这是最难定位的一类 bug。
 */
describe('translationCache / 键构造', () => {
  it('should include profile version, language and address', () => {
    const key = cacheKey('p1', 'zh-CN', 'cabc');
    expect(key).toContain('p1');
    expect(key).toContain('zh-CN');
    expect(key).toContain('cabc');
  });

  it('should change when the profile version changes (AC6 遮蔽 bug 回归)', () => {
    expect(cacheKey('p1', 'zh-CN', 'cabc')).not.toBe(cacheKey('p2', 'zh-CN', 'cabc'));
  });

  it('should change when the target language changes', () => {
    expect(cacheKey('p1', 'zh-CN', 'cabc')).not.toBe(cacheKey('p1', 'ja-JP', 'cabc'));
  });

  it('should change when the address changes', () => {
    expect(cacheKey('p1', 'zh-CN', 'cabc')).not.toBe(cacheKey('p1', 'zh-CN', 'cabd'));
  });

  it('should be unambiguous when parts contain the separator', () => {
    // 若用简单拼接，('a|b','c') 与 ('a','b|c') 会撞键
    expect(cacheKey('a|b', 'c', 'd')).not.toBe(cacheKey('a', 'b|c', 'd'));
  });
});

describe('translationCache / MemoryCache', () => {
  it('should store and retrieve a value', async () => {
    const cache = new MemoryCache();
    await cache.set('k1', { source: 'src', text: 'dst', at: 1 });
    expect(await cache.get('k1')).toEqual({ source: 'src', text: 'dst', at: 1 });
  });

  it('should return null for a missing key', async () => {
    expect(await new MemoryCache().get('nope')).toBeNull();
  });

  it('should return only present keys from getMany', async () => {
    const cache = new MemoryCache();
    await cache.set('a', { source: 'sa', text: 'ta', at: 1 });
    const hits = await cache.getMany(['a', 'b']);
    expect([...hits.keys()]).toEqual(['a']);
  });

  it('should write many entries at once', async () => {
    const cache = new MemoryCache();
    await cache.setMany([
      ['a', { source: 'sa', text: 'ta', at: 1 }],
      ['b', { source: 'sb', text: 'tb', at: 2 }],
    ]);
    expect((await cache.getMany(['a', 'b'])).size).toBe(2);
  });

  it('should evict the oldest entry when exceeding the limit', async () => {
    const cache = new MemoryCache(2);
    await cache.set('a', { source: 's', text: 't', at: 1 });
    await cache.set('b', { source: 's', text: 't', at: 2 });
    await cache.set('c', { source: 's', text: 't', at: 3 });
    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('c')).not.toBeNull();
  });

  it('should keep the source text so collisions degrade to a miss', async () => {
    // 哈希碰撞时，读取方逐字节比对 source —— 这是「碰撞是可用性问题而非正确性问题」的实现基础
    const cache = new MemoryCache();
    await cache.set('k', { source: 'original', text: 'translated', at: 1 });
    const hit = await cache.get('k');
    expect(hit?.source).toBe('original');
  });
});

// 持久化实现的用例（整文件 JSON / 版本校验 / 损坏降级 / 淘汰 / validate 抛异常）
// 已随实现上移到 `src/shared/cache/__tests__/persistentKeyValueStore.test.ts`。
// 本文件只覆盖**业务侧**：键构造（含 profileVersion 遮蔽回归）与内存实现。
