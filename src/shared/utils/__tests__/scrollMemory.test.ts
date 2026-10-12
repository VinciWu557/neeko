import { beforeEach, describe, expect, it } from 'vitest';

import {
  __resetScrollMemoryForTest,
  buildScrollKey,
  dropScrollMemoryForOwner,
  readScrollMemory,
  writeScrollMemory,
} from '../scrollMemory';

describe('scrollMemory（L1 纯缓存）', () => {
  beforeEach(() => {
    __resetScrollMemoryForTest();
  });

  it('键分段隔离：owner/sub 边界不串位，默认值与显式空段等价', () => {
    expect(buildScrollKey('s', 'a', 'b')).not.toBe(buildScrollKey('s', 'ab', ''));
    expect(buildScrollKey('s', 'a', 'b')).toBe(buildScrollKey('s', 'a', 'b'));
    expect(buildScrollKey('s')).toBe(buildScrollKey('s', '', ''));
  });

  it('拒收非有限值、clamp 负值（NaN 会在 scrollTo 处抛 TypeError）', () => {
    const k = buildScrollKey('s');
    writeScrollMemory(k, Number.NaN);
    writeScrollMemory(k, Number.POSITIVE_INFINITY);
    writeScrollMemory(k, Number.NEGATIVE_INFINITY);
    expect(readScrollMemory(k)).toBeUndefined();

    writeScrollMemory(k, -5);
    expect(readScrollMemory(k)).toBe(0);
  });

  it('dropScrollMemoryForOwner 只删精确匹配的 owner 段', () => {
    writeScrollMemory(buildScrollKey('s', 'a'), 10);
    writeScrollMemory(buildScrollKey('s', 'ab'), 20);
    writeScrollMemory(buildScrollKey('s', 'a', 'sub'), 30);

    dropScrollMemoryForOwner('a');

    expect(readScrollMemory(buildScrollKey('s', 'a'))).toBeUndefined();
    expect(readScrollMemory(buildScrollKey('s', 'a', 'sub'))).toBeUndefined();
    expect(readScrollMemory(buildScrollKey('s', 'ab'))).toBe(20);
  });

  it('超过上限按 LRU 淘汰最旧条目', () => {
    for (let i = 0; i < 301; i++) {
      writeScrollMemory(buildScrollKey('s', null, String(i)), i);
    }
    expect(readScrollMemory(buildScrollKey('s', null, '0'))).toBeUndefined();
    expect(readScrollMemory(buildScrollKey('s', null, '300'))).toBe(300);
  });

  it('重写已有键会刷新 LRU 序位（最旧者先被淘汰）', () => {
    for (let i = 0; i < 300; i++) {
      writeScrollMemory(buildScrollKey('s', null, String(i)), i);
    }
    writeScrollMemory(buildScrollKey('s', null, '0'), 999); // 刷新 recency
    writeScrollMemory(buildScrollKey('s', null, 'new'), 1); // 第 301 条 → 淘汰最旧

    expect(readScrollMemory(buildScrollKey('s', null, '0'))).toBe(999);
    expect(readScrollMemory(buildScrollKey('s', null, '1'))).toBeUndefined();
  });
});
