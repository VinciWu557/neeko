// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * 译文样式的**静态护栏**。
 *
 * ## 为什么必须有这一条
 *
 * `commentView.ts` 产出六个类名，但样式规则可以做「零成本消失」：
 * 2026-10-19 实测 `grep cm-comment-translation src/styles/` **为空** —— 功能全链可用，
 * 300+ 条测试全绿，但 below 译文块与原文注释视觉上无法区分、失败 reason 是裸文字。
 *
 * 与 `entryWiring.test.ts` 同型：渲染层测得到 widget 的 `className` 字符串，测不到
 * 「这个类名有没有规则」。CSS 的视觉效果无法单测，但「规则存在」这一事实可以静态断言。
 *
 * 判据只查**类名出现**（不是查具体属性）：允许后续调整配色/间距而不动本用例，
 * 但删掉任何一条规则都会立刻变红。
 */
const EDITOR_CSS = 'src/styles/components/editor.css';
const STYLES_INDEX = 'src/styles/index.css';

/** `commentView.ts` 实际使用的全部类名（唯一来源，别在这里增删）。 */
const CLASSES = [
  'cm-comment-translation',
  'cm-comment-translation--below',
  'cm-comment-translation--inline',
  'cm-comment-translation__line',
  'cm-comment-translation__reason',
  'cm-comment-translation__hover-anchor',
] as const;

const css = readFileSync(EDITOR_CSS, 'utf8');

/**
 * 类名作为**选择器 token** 出现（后面不再是标识符字符）。
 *
 * 不能用 `includes('.cm-comment-translation__reason')` —— 它会被
 * `__reason-xxx` 这类变体命中，把「规则被改名」误判成存在（变异验证实测过）。
 */
function selectorIndex(name: string): number {
  const match = new RegExp(`\\.${name}(?![\\w-])`).exec(css);
  return match ? match.index : -1;
}

describe('stylesWiring / 注释译文样式', () => {
  it('should define a rule for every class name the renderer emits', () => {
    const missing = CLASSES.filter((name) => selectorIndex(name) === -1);
    expect(missing).toEqual([]);
  });

  it('should keep editor.css imported by the style entry', () => {
    // 规则写对但文件没被 @import → 样式静默不生效（与「入口没挂」同型的静默失败）
    expect(readFileSync(STYLES_INDEX, 'utf8')).toContain('components/editor.css');
  });

  it('should use the mono role token instead of a hardcoded font stack', () => {
    // `quality-guidelines.md` 字体角色约定：注释是代码语境 → 必须走 var(--font-mono)，
    // 禁止裸 font-family（另有 check_font_family_guard 护栏，这里锁住「本组规则用了它」）。
    const base = selectorIndex('cm-comment-translation');
    expect(base).toBeGreaterThan(-1);
    expect(css.slice(base, base + 300)).toContain('font-family: var(--font-mono)');
  });

  it('should style the failure reason with the red accent so it reads as an error', () => {
    const start = selectorIndex('cm-comment-translation__reason');
    expect(start).toBeGreaterThan(-1);
    expect(css.slice(start, start + 400)).toContain('var(--accent-red)');
  });
});
