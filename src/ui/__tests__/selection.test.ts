/**
 * `optionSecondary()` —— 选中项次级文字的完整 class。
 *
 * 这个函数只有一行，但它守护的是一个**反复踩过 7 次**的坑：
 * 下拉项选中时父元素底色变 `bg-accent-blue`，子元素若还用 `text-text-muted`，
 * 暗色主题下灰字压在蓝底上几乎不可见。
 *
 * 抽成函数是为了让「加选中态」时不可能忘记子元素
 * （`.trellis/spec/frontend/design-tokens.md` 坑 6）。
 *
 * ## 为什么测「完整 class」而不是「只有颜色」
 *
 * 7 处调用完全同形（右对齐 + 小字号 + 颜色）。只封颜色的话，
 * `ml-auto text-xs` 会被复制 7 份 —— 布局知识散落，改一次漏六次。
 */

import { describe, it, expect } from 'vitest';

import { optionSecondary } from '../selection';

describe('optionSecondary —— 选中项次级文字', () => {
  it('选中时用 on-accent 系（不是 text-text-muted）', () => {
    expect(optionSecondary(true)).toContain('text-text-on-accent/80');
    expect(optionSecondary(true)).not.toContain('text-text-muted');
  });

  it('未选中时用页面次级文字色', () => {
    expect(optionSecondary(false)).toContain('text-text-muted');
    expect(optionSecondary(false)).not.toContain('text-text-on-accent');
  });

  it('两种状态都带布局类（右对齐 + 小字号）', () => {
    // 布局知识与颜色知识在同一个来源 —— 调用处不必再写 cn('ml-auto text-xs', ...)
    for (const selected of [true, false]) {
      expect(optionSecondary(selected)).toContain('ml-auto');
      expect(optionSecondary(selected)).toContain('text-xs');
    }
  });

  it('选中态带透明度后缀（保留与主文字的主次对比）', () => {
    // 选中项里主文字是 text-text-on-accent，次级文字若也 100% 会糊成一片。
    expect(optionSecondary(true)).toContain('/80');
  });

  it('两个分支必须不同（否则等于没切换）', () => {
    // 变异保护：若哪天有人把两个分支改成同值，这个用例会红。
    expect(optionSecondary(true)).not.toBe(optionSecondary(false));
  });

  it('选中态不能是任何「页面文字色」', () => {
    // 这三个压在 accent 实底上都会失去对比度。
    for (const wrong of ['text-text-muted', 'text-text-primary', 'text-text-secondary']) {
      expect(optionSecondary(true)).not.toContain(wrong);
    }
  });
});
