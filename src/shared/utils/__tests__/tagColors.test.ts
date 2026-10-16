// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { tagChipClass, tagGroupBadgeClass } from '../tagColors';

describe('tagColors', () => {
  it('黄金值：canonical 哈希映射（换哈希会让全部 tag 重新着色，此处是刹车）', () => {
    expect(tagChipClass('test')).toBe('bg-accent-green/10 text-text-secondary');
    expect(tagChipClass('frontend')).toBe('bg-bg-hover text-text-secondary');
    expect(tagChipClass('database')).toBe('bg-bg-selected text-text-secondary');
    expect(tagChipClass('search')).toBe('bg-accent-yellow/10 text-text-secondary');
  });

  it('确定性：同输入恒同色（含空串 / 长串 / 非 ASCII）', () => {
    for (const tag of ['', 'x'.repeat(64), '文档', 'multi word tag']) {
      const first = tagChipClass(tag);
      expect(tagChipClass(tag)).toBe(first);
      expect(first.length).toBeGreaterThan(0);
    }
  });

  it('tag 与 tag group 走各自调色板：黄金值 + 同名可不同色', () => {
    expect(tagGroupBadgeClass('Frontend')).toBe('bg-bg-selected text-text-secondary');
    expect(tagGroupBadgeClass('Backend')).toBe('bg-accent-yellow/15 text-accent-yellow');
    // 同名字符串在两套调色板下的落点本就独立（此处恰好不同色，防止误复用同一个裸索引）
    expect(tagGroupBadgeClass('Frontend')).not.toBe(tagChipClass('Frontend'));
  });
});
