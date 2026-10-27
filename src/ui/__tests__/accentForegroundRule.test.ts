/**
 * ESLint 规则 `neeko/ui/accent-foreground` 的用例。
 *
 * 规则本体在 `tools/eslint-rules/accent-foreground.cjs`（CommonJS —— 仓根
 * `package.json` 是 `"type": "module"`，`.js` 会被当 ESM，故用 `.cjs`）。
 *
 * ## 为什么这条规则值得单独测
 *
 * 它要回答的问题听起来很窄 ——「压在 accent 实底上的文字该用什么颜色」——
 * 但第一版实现扫全仓报出 **22 处告警，逐一核实后全是误报**：
 *
 * | 误报来源 | 处数 | 真相 |
 * | --- | --- | --- |
 * | `bg-accent-blue/15` 被当成实底 | 16 | 半透明底是「海面 + 淡 accent」，普通文字色是对的 |
 * | `text-xs` / `text-sm` 被当成颜色 | 5 | 那是字号 |
 * | `hover:border-accent-blue` 被当成底色 | — | 是 border 不是 bg |
 * | `data-[state=on]:bg-accent-blue` 被当成底色 | — | 状态变体，与前景色互斥 |
 * | 三元两分支被合并 | 10 | `ok ? 'bg-accent-blue text-on-accent' : 'bg-bg-tertiary text-muted'` |
 *
 * 误报会让人直接关掉规则 —— 比没有规则更糟。所以下面「放行」用例
 * 每条都对应一个真实踩过的样本，它们是这组测试的主体。
 */

import { createRequire } from 'node:module';

import { Linter } from 'eslint';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const parser = require('@typescript-eslint/parser');

const rule = require('../../../tools/eslint-rules/accent-foreground.cjs');

const linter = new Linter();
linter.defineRule('r', rule);
linter.defineParser('ts', parser);

/** 对一段 JSX 跑规则，返回违规数量 */
function violations(jsx: string): number {
  return linter.verify(
    `const a = ${jsx};`,
    {
      parser: 'ts',
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      rules: { r: 'error' },
    },
    'a.tsx',
  ).length;
}

describe('neeko/ui/accent-foreground —— 应报违规', () => {
  it('同元素：accent 实底 + text-text-primary', () => {
    expect(violations('<div className="bg-accent-blue text-text-primary" />')).toBe(1);
  });

  it('同元素：accent 实底 + text-text-secondary', () => {
    expect(violations('<div className="bg-accent-blue text-text-secondary" />')).toBe(1);
  });

  it('子元素：压在 accent 实底上的灰字', () => {
    expect(
      violations('<div className="bg-accent-blue"><span className="text-text-muted" /></div>'),
    ).toBe(1);
  });

  it('深层嵌套：accent 实底的第 3 层子元素', () => {
    expect(
      violations(
        '<div className="bg-accent-blue"><div><span className="text-text-primary" /></div></div>',
      ),
    ).toBe(1);
  });

  it('destructive 实底 + 错前景色', () => {
    expect(violations('<div className="bg-destructive text-text-primary" />')).toBe(1);
  });

  it('cn() 里的实底 + 错前景色', () => {
    expect(violations('<div className={cn("bg-accent-blue", x && "text-text-primary")} />')).toBe(
      1,
    );
  });

  it('三元分支内部真错', () => {
    expect(violations('<div className={cn(ok ? "bg-accent-blue text-text-muted" : "x")} />')).toBe(
      1,
    );
  });
});

describe('neeko/ui/accent-foreground —— 应放行（真实误报样本）', () => {
  it('半透明 accent 底 + 普通文字色', () => {
    // `bg-accent-blue/15` 是「海面 + 淡 accent」。正则版护栏用 `\b` 边界
    // 曾把它判成实底 → 16 处误报。
    expect(violations('<div className="bg-accent-blue/15 text-text-primary" />')).toBe(0);
  });

  it('字号类不是颜色', () => {
    expect(violations('<div className="bg-accent-blue text-xs" />')).toBe(0);
    expect(violations('<div className="bg-accent-blue text-sm" />')).toBe(0);
  });

  it('纯色块无文字', () => {
    expect(violations('<div className="bg-accent-blue" />')).toBe(0);
  });

  it('hover 边框变 accent 不是 accent 底', () => {
    expect(
      violations('<div className="bg-bg-tertiary text-text-primary hover:border-accent-blue" />'),
    ).toBe(0);
  });

  it('边框色 accent', () => {
    expect(violations('<div className="border-l-accent-green text-text-primary" />')).toBe(0);
  });

  it('淡 accent 底 + 同色文字（错误提示框的既定写法）', () => {
    expect(violations('<p className="text-accent-red bg-accent-red/10" />')).toBe(0);
  });

  it('data-[state] 变体互斥', () => {
    // 未选中 bg-none + text-text-secondary；选中才 bg-accent-blue + text-text-on-accent。
    // 两个状态不是「底 + 前景」关系。
    expect(
      violations(
        '<div className="bg-none text-text-secondary data-[state=on]:bg-accent-blue data-[state=on]:text-text-on-accent" />',
      ),
    ).toBe(0);
  });

  it('三元互斥分支不合并判定', () => {
    // PRCommentInput 提交按钮的真实写法。合并分支会得出
    // 「bg-accent-blue 上压着 text-text-muted」这个根本不存在的组合（实测 10 处误报）。
    expect(
      violations(
        '<button className={cn("px-4", ok ? "bg-accent-blue text-text-on-accent" : "bg-bg-tertiary text-text-muted")} />',
      ),
    ).toBe(0);
  });
});

describe('neeko/ui/accent-foreground —— 合法写法', () => {
  it('text-text-on-accent', () => {
    expect(violations('<div className="bg-accent-blue text-text-on-accent" />')).toBe(0);
  });

  it('text-text-on-accent/80（带透明度）', () => {
    // 选中项里的次级文字（命令、路径）用 80% 保留层级感，是本仓既定写法。
    expect(violations('<div className="bg-accent-blue text-text-on-accent/80" />')).toBe(0);
  });

  it('text-[var(--text-on-accent)] 任意值写法', () => {
    expect(violations('<div className="bg-accent-blue text-[var(--text-on-accent)]" />')).toBe(0);
  });

  it('text-destructive-foreground', () => {
    expect(violations('<div className="bg-destructive text-destructive-foreground" />')).toBe(0);
  });

  it('非 accent 底上的普通文字色', () => {
    expect(violations('<div className="bg-bg-tertiary text-text-primary" />')).toBe(0);
  });

  it('子元素已处理选中态（三元切到 on-accent）', () => {
    expect(
      violations(
        '<div className="bg-accent-blue"><span className={cn(sel ? "text-text-on-accent/80" : "text-text-muted")} /></div>',
      ),
    ).toBe(0);
  });
});
