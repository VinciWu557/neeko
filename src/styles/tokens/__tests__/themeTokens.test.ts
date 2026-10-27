// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 主题 token 完整性守卫。
 *
 * 背景：新增 `--accent-brick`（untracked 文件状态色）时只补了 classic-dark /
 * one-dark-pro / claude 三个主题块，漏掉默认 dark / light —— CSS 变量在该主题下
 * 未定义时 `color: var(--x)` 回退为继承色，表现为「颜色静默失效」（2026-08-28）。
 * 本测试防止同类遗漏：新增 accent token 时必须覆盖全部主题块。
 */
describe('theme token integrity', () => {
  const css = readFileSync(resolve(__dirname, '../theme.css'), 'utf8');

  /** 提取每个顶层 `:root ... { ... }` 主题块内定义的 CSS 自定义属性名 */
  function extractThemeVars(cssText: string): Map<string, Set<string>> {
    const themes = new Map<string, Set<string>>();
    const blockRe = /(^:root[^{]*)\{([^}]*)\}/gm;
    for (const match of cssText.matchAll(blockRe)) {
      const selector = (match[1] ?? '').replace(/\s+/g, ' ').trim();
      const body = match[2] ?? '';
      const vars = new Set<string>();
      for (const varMatch of body.matchAll(/--[\w-]+(?=\s*:)/g)) {
        vars.add(varMatch[0]);
      }
      themes.set(selector, vars);
    }
    return themes;
  }

  const themes = extractThemeVars(css);

  it('parses theme blocks from theme.css', () => {
    // 健全性：正则确实捕获到了主题块（防正则失配导致测试空转）
    expect(themes.size).toBeGreaterThanOrEqual(5);
  });

  it('defines --accent-brick in every theme block that carries an accent palette', () => {
    // 只校验承载 accent 色板的块（:root 基础块只有字体/终端兜底，无 accent，天然排除）
    const accentBlocks = [...themes.entries()].filter(([, vars]) => {
      let accentCount = 0;
      for (const v of vars) if (v.startsWith('--accent-')) accentCount += 1;
      return accentCount >= 3;
    });
    expect(accentBlocks.length).toBeGreaterThanOrEqual(5);

    const missing = accentBlocks
      .filter(([, vars]) => !vars.has('--accent-brick'))
      .map(([selector]) => `${selector} 缺少 --accent-brick`);
    expect(missing).toEqual([]);
  });

  it('defines --mono-fg and --mono-fg-dim in every theme block that carries text palette', () => {
    const textBlocks = [...themes.entries()].filter(([, vars]) => vars.has('--text-primary'));
    expect(textBlocks.length).toBeGreaterThanOrEqual(5);
    const missingFg = textBlocks
      .filter(([, vars]) => !vars.has('--mono-fg'))
      .map(([selector]) => `${selector} 缺少 --mono-fg`);
    const missingDim = textBlocks
      .filter(([, vars]) => !vars.has('--mono-fg-dim'))
      .map(([selector]) => `${selector} 缺少 --mono-fg-dim`);
    expect(missingFg).toEqual([]);
    expect(missingDim).toEqual([]);
  });

  it('defines --mono-fg in :root fallback', () => {
    const root = themes.get(':root');
    expect(root?.has('--mono-fg')).toBe(true);
    expect(root?.has('--mono-fg-dim')).toBe(true);
  });

  /** git 文件状态色板：与 UI accent 解耦，必须每个主题块自带，否则 var 静默回退。 */
  const GIT_STATUS_TOKENS = [
    '--git-status-added',
    '--git-status-modified',
    '--git-status-deleted',
    '--git-status-untracked',
    '--git-status-conflict',
  ];

  it('defines the full --git-status-* palette in every accent-bearing theme block', () => {
    const accentBlocks = [...themes.entries()].filter(([, vars]) => {
      let accentCount = 0;
      for (const v of vars) if (v.startsWith('--accent-')) accentCount += 1;
      return accentCount >= 3;
    });
    expect(accentBlocks.length).toBeGreaterThanOrEqual(5);

    const missing = accentBlocks.flatMap(([selector, vars]) =>
      GIT_STATUS_TOKENS.filter((token) => !vars.has(token)).map(
        (token) => `${selector} 缺少 ${token}`,
      ),
    );
    expect(missing).toEqual([]);
  });

  it('defines the --git-status-* fallback in :root (unknown data-theme)', () => {
    const root = themes.get(':root');
    const missing = GIT_STATUS_TOKENS.filter((token) => !root?.has(token));
    expect(missing).toEqual([]);
  });

  it('mirrors every --git-status-* token into the Tailwind bridge', () => {
    // 缺一条桥接 ⇒ text-git-status-* 静默不生成（与「声明了不生效」同型，必须机器守）。
    const tailwindCss = readFileSync(resolve(__dirname, '../tailwind.css'), 'utf8');
    const missing = GIT_STATUS_TOKENS.filter(
      (token) => !tailwindCss.includes(`--color-${token.slice(2)}:`),
    );
    expect(missing).toEqual([]);
  });

  // ── Switch 轨道：控件对比度是硬判据，不能靠人眼看 ──────────────────────

  it('defines --switch-track in every block that carries the surface palette', () => {
    // 2026-10-27 用户反馈「特别在 claude、light 主题下面特别明显的不协调」：
    // 未勾选态的轨道曾复用 --bg-tertiary（表面层级色），与海面对比只有
    // 1.08（light）/ 1.11（claude）—— 轨道消失，只剩一颗深色圆球漂着。
    const surfaceBlocks = [...themes.entries()].filter(([, vars]) => vars.has('--bg-tertiary'));
    expect(surfaceBlocks.length).toBeGreaterThanOrEqual(5);

    const missing = surfaceBlocks
      .filter(([, vars]) => !vars.has('--switch-track'))
      .map(([selector]) => `${selector} 缺少 --switch-track`);
    expect(missing).toEqual([]);
  });

  it('keeps every --switch-track distinguishable from its own --bg-primary', () => {
    // 判据不是「值存在」而是「真的成形」：轨道 vs 海面 ≥1.5。
    // 这条会随着主题调色而自动把关 —— 改任何一个主题的底色都要重算轨道色。
    const surfaceBlocks = [...themes.entries()].filter(
      ([, vars]) => vars.has('--bg-tertiary') && vars.has('--switch-track'),
    );

    const failures: string[] = [];
    for (const [selector] of surfaceBlocks) {
      const bg = readColor(css, selector, '--bg-primary');
      const track = readColor(css, selector, '--switch-track');
      if (!bg || !track) {
        failures.push(`${selector} 颜色无法解析`);
        continue;
      }
      const ratio = contrastRatio(bg, track);
      if (ratio < 1.5) {
        failures.push(`${selector} 轨道对比 ${ratio.toFixed(2)} < 1.5（轨道会消失）`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('mirrors --switch-track into the Tailwind bridge', () => {
    const tailwindCss = readFileSync(resolve(__dirname, '../tailwind.css'), 'utf8');
    expect(tailwindCss).toContain('--color-switch-track:');
  });
});

// ── 颜色对比度工具（仅支持本仓用到的 #rrggbb 与 oklch(L C H)）─────────────

type Rgb = [number, number, number];

/** 从指定主题块里读出某个 token 的原始值（只在该块体内搜索，避免跨块串味） */
function readColor(cssText: string, selector: string, token: string): Rgb | null {
  const blockRe = /(^:root[^{]*)\{([^}]*)\}/gm;
  for (const match of cssText.matchAll(blockRe)) {
    const sel = (match[1] ?? '').replace(/\s+/g, ' ').trim();
    if (sel !== selector) continue;
    const valueRe = new RegExp(`${token}\\s*:\\s*([^;]+);`);
    const value = (match[2] ?? '').match(valueRe)?.[1]?.trim();
    return value ? parseColor(value) : null;
  }
  return null;
}

function parseColor(value: string): Rgb | null {
  const hex = value.match(/^#([0-9a-fA-F]{6})$/);
  if (hex) {
    const h = hex[1] as string;
    return [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255,
    ];
  }
  const ok = value.match(/^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/[^)]*)?\)$/);
  if (ok) return oklchToRgb(Number(ok[1]), Number(ok[2]), Number(ok[3]));
  return null;
}

function oklchToRgb(L: number, C: number, H: number): Rgb {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const enc = (c: number) => {
    const clamped = Math.max(0, Math.min(1, c));
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  };
  return lin.map(enc) as Rgb;
}

function relativeLuminance([r, g, b]: Rgb): number {
  const f = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
