/**
 * 主题 CSS 文件的解析工具（供 `themeTokens.test.ts` 使用）。
 *
 * ## 为什么按「文件」而不是按「选择器块」识别主题
 *
 * 这是本模块的核心判据，也是 2026-10-28 一次真实漏网的教训。
 *
 * 旧实现用**内容特征**判断「这块是不是主题」：
 *
 * ```ts
 * .filter(([, vars]) => vars.size > 10)          // 变量够多才算
 * .filter(([, vars]) => accentCount >= 3)        // 有 accent 才算
 * .filter(([, vars]) => vars.has('--bg-tertiary')) // 有表面色才算
 * ```
 *
 * 后果实测：往 `themes/` 放一个只写了 1 个变量（或只有 `color-scheme`）的
 * 新主题文件，**全部 18 个测试通过、护栏 0 违规** —— 「新主题还没填完就提交」
 * 这个最可能发生的错误恰好被放过了，运行时表现为 `var(--x)` 回退为继承色
 * （颜色静默失效，正是本测试要防的那个 2026-08-28 事故）。
 *
 * 正确的判据：**文件在 `themes/` 里 ⇒ 它是主题**。不需要任何内容特征。
 * 一个文件内可以有多个 `:root` 块（`color-scheme` 声明 + 变量声明），
 * 按文件合并变量即可。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 剥掉 CSS 注释。
 *
 * ## 为什么必须剥（2026-10-28 踩到）
 *
 * 判据只能在**源码**上跑，注释不是源码。不剥时实测过的三种假阳性：
 *
 * 1. 文档注释里写一句 `--terminal-bg: var(--bg-secondary)` → `[^;]+` 吃到下一个
 *    `;`（跨行），把一个**从不存在于该主题的变量**登记进变量清单，报「多出未登记变量」；
 * 2. 注释里举例一个 `:root { }` 块 → `BLOCK_RE` 当真块解析；
 * 3. 注释里提一句 `color-scheme:` → `lacksColorScheme` 假通过。
 *
 * 失效方向都是「注释的内容被当成声明」，即**误导维护者去改正确的东西**。
 *
 * 只剥块注释（斜杠星号开头到星号斜杠），不碰 `//`：CSS 没有行注释，
 * 而 `url(https://…)` 里的双斜杠会被误剥。
 */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** 一个主题文件的解析结果 */
export interface ThemeFile {
  /** 文件名（如 `dark.css`），用于报错定位 */
  file: string;
  /** 该文件内**全部** `:root` 块的变量并集 */
  vars: Set<string>;
  /** 原始文本（含注释），供需要逐字保留的用例使用 */
  raw: string;
}

const THEMES_DIR = resolve(__dirname, '../themes');

/** 匹配 `:root ... { ... }` 块（选择器可跨行），捕获选择器与块体 */
const BLOCK_RE = /(^:root[^{]*)\{([^}]*)\}/gm;

/** 从一段 CSS 里取出「选择器 → 该块的变量名列表」（注释已剥离） */
export function splitBlocks(css: string): { selector: string; vars: string[] }[] {
  return [...stripComments(css).matchAll(BLOCK_RE)].map((m) => ({
    selector: (m[1] ?? '').replace(/\s+/g, ' ').trim(),
    vars: [...(m[2] ?? '').matchAll(/--[\w-]+(?=\s*:)/g)].map((v) => v[0]),
  }));
}

/**
 * 读出 `themes/` 下的全部主题文件。
 *
 * 不做任何内容过滤 —— 目录本身即「这是主题」的声明。
 */
export function readThemeFiles(): ThemeFile[] {
  return readdirSync(THEMES_DIR)
    .filter((f) => f.endsWith('.css'))
    .sort()
    .map((file) => {
      const raw = readFileSync(resolve(THEMES_DIR, file), 'utf8');
      const vars = new Set(splitBlocks(raw).flatMap((b) => b.vars));
      return { file, vars, raw };
    });
}

/** 读出 `base/variables.css`（全局兜底值，需与主题分开校验） */
export function readGlobalVars(): { raw: string; vars: Set<string> } {
  const raw = readFileSync(resolve(__dirname, '../base/variables.css'), 'utf8');
  return { raw, vars: new Set(splitBlocks(raw).flatMap((b) => b.vars)) };
}

// ── 颜色取值与对比度（仅支持本仓用到的 #rrggbb 与 oklch(L C H)）───────────

export type Rgb = [number, number, number];

/**
 * 从主题文件里读某个 token 的颜色值。
 *
 * 同一 token 可能出现在多个块里（如 `color-scheme` 块不含变量、变量块才有）；
 * 取**第一个能解析出颜色的**出现位置。
 */
export function colorOf(theme: ThemeFile, token: string): Rgb | null {
  const valueRe = new RegExp(`${token}\\s*:\\s*([^;]+);`);
  for (const m of stripComments(theme.raw).matchAll(BLOCK_RE)) {
    const value = (m[2] ?? '').match(valueRe)?.[1]?.trim();
    if (value) return parseColor(value);
  }
  return null;
}

export function parseColor(value: string): Rgb | null {
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

/** WCAG 相对对比度 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ── 判据：抽成纯函数，才能用坏数据直接驱动 ────────────────────────────────
//
// 为什么必须是纯函数而不是写在测试里的 inline 逻辑：
//
// 2026-10-28 的教训。判据原先写成测试内的 `themes.flatMap(...)`，配套的
// 「反证」用例却自己用 `THEME_VARIABLES.filter(...)` 重算了一遍 ——
// **完全没走判据代码路径**，于是它无论判据怎么写都会绿（假测试）。
//
// 同一时期，人工用临时 bash/python 脚本注入坏数据来验证，脚本写在对话里、
// 不进仓库、无法 review。其中一次写成 `s[:-2]`（删掉的是尾部空行而非闭合
// 括号），得出了「语法错误也能被容忍」的**错误结论**，下一轮才靠重做实验
// 发现是脚本本身错了。
//
// 结论：判据抽成可喂数据的纯函数，坏数据用例写进测试文件。临时脚本不可信。

/** 一个主题文件相对契约的缺陷 */
export interface ThemeFileDefects {
  /** 契约里有、文件里没有的变量 */
  missingVars: string[];
  /** 文件里有、契约里没有的变量（新增了却漏登记） */
  unknownVars: string[];
  /** 是否缺少 `color-scheme` 声明 */
  lacksColorScheme: boolean;
}

/**
 * 体检一个主题文件。
 *
 * @param file     已解析的主题文件（`vars` 是文件内全部 `:root` 块的并集）
 * @param contract 变量契约（`THEME_VARIABLES`）
 *
 * 不做任何「变量够多才算主题」的内容判断 —— 传进来的就是主题。
 */
export function inspectThemeFile(file: ThemeFile, contract: readonly string[]): ThemeFileDefects {
  const contractSet = new Set(contract);
  return {
    missingVars: contract.filter((token) => !file.vars.has(token)),
    unknownVars: [...file.vars].filter((token) => !contractSet.has(token)),
    lacksColorScheme: !stripComments(file.raw).includes('color-scheme:'),
  };
}

/** 把缺陷渲染成可读的失败信息（空数组 = 无缺陷） */
export function describeDefects(file: ThemeFile, defects: ThemeFileDefects): string[] {
  const out: string[] = [];
  for (const token of defects.missingVars) out.push(`${file.file} 缺少 ${token}`);
  for (const token of defects.unknownVars) out.push(`${file.file} 多出未登记变量 ${token}`);
  if (defects.lacksColorScheme) out.push(`${file.file} 缺少 color-scheme`);
  return out;
}

/**
 * 从 CSS 源码直接构造 {@link ThemeFile}（供坏数据用例使用）。
 *
 * 走的是与真实文件**完全相同**的解析路径（`splitBlocks`），
 * 所以坏数据用例驱动的是真实代码，不是测试内重算。
 */
export function themeFileFromSource(source: string, name = 'fixture.css'): ThemeFile {
  return {
    file: name,
    vars: new Set(splitBlocks(source).flatMap((b) => b.vars)),
    raw: source,
  };
}
