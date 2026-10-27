/**
 * 本地 ESLint 插件 —— Neeko 特有的架构 / 样式约束。
 *
 * 为什么不放 npm 依赖：这些规则依赖本仓的 token 体系与目录约定，
 * 外部插件无从知道；而它们必须与代码同仓演进（改 token 就要改规则）。
 *
 * 现有规则：
 * - `ui/accent-foreground`：压在实底 accent 上的元素，前景色必须是
 *   accent 底上的前景色（`--text-on-accent` 系）。
 *   起因：2026-10-27 三轮「UI 精致化」返工都是同一个错误 —— 只想「它是文字」，
 *   忘了「它压在什么底上」。
 */

'use strict';

const accentForeground = require('./accent-foreground.cjs');

module.exports = {
  rules: {
    'ui/accent-foreground': accentForeground,
  },
};
