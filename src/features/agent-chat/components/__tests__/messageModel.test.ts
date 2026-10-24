import { describe, expect, it } from 'vitest';

import { contextWindowOf } from '../messageModel';

/**
 * `contextWindowOf` 的新语义（pi `get_session_stats` 口径）：
 *
 * - `used = context_tokens ?? input_tokens`（compaction 后 context 缺失回退累计 input）
 * - `limit = context_limit ?? null`（未知为 null，UI 不渲染进度条/百分比）
 * - cache 三值（read/write/input）齐备且分母 > 0 才派生 `hitRate`
 * - usage 全空 / 无「已用」值 → null（不渲染计量器，禁止假数据）
 */
describe('contextWindowOf', () => {
  it('maps a full usage payload with cache derivation', () => {
    const win = contextWindowOf({
      model: 'auto/dv4',
      usage: {
        input_tokens: 1234,
        output_tokens: 567,
        context_tokens: 205_000,
        context_limit: 1_000_000,
        cache_read_tokens: 197_400,
        cache_write_tokens: 1200,
      },
    });
    expect(win).not.toBeNull();
    expect(win!.used).toBe(205_000);
    expect(win!.limit).toBe(1_000_000);
    expect(win!.model).toBe('auto/dv4');
    expect(win!.cache).toEqual({
      read: 197_400,
      write: 1200,
      input: 1234,
      hitRate: 197_400 / (1234 + 197_400 + 1200),
    });
  });

  it('falls back to input_tokens when context_tokens is missing', () => {
    const win = contextWindowOf({
      model: 'm',
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    expect(win!.used).toBe(100);
  });

  it('reports a null limit when context_limit is unknown', () => {
    const win = contextWindowOf({
      model: 'm',
      usage: { input_tokens: 100, context_tokens: 90 },
    });
    expect(win!.limit).toBeNull();
    // 无 cache 字段 → 不派生
    expect(win!.cache).toBeUndefined();
  });

  it('omits cache when any of the three counters is missing', () => {
    const partial = contextWindowOf({
      model: 'm',
      usage: { input_tokens: 10, cache_read_tokens: 5 }, // 缺 write
    });
    expect(partial!.cache).toBeUndefined();

    const zeroDenom = contextWindowOf({
      model: 'm',
      usage: { input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    });
    expect(zeroDenom!.cache).toBeUndefined(); // 分母为 0：命中率无意义
  });

  it('returns null for an empty or absent usage payload', () => {
    expect(contextWindowOf({ model: 'm', usage: {} })).toBeNull();
    expect(contextWindowOf({ model: 'm', usage: null })).toBeNull();
    expect(contextWindowOf({ model: 'm' })).toBeNull();
    // 没有「已用」值（context 与 input 都缺）也没有可渲染的内容。
    expect(contextWindowOf({ model: 'm', usage: { output_tokens: 9 } })).toBeNull();
  });

  it('defaults the model label when the event carries none', () => {
    const win = contextWindowOf({ model: null, usage: { input_tokens: 1 } });
    expect(win!.model).toBe('unknown');
  });
});
