// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { THEME_VARIABLES, THEME_VARIABLE_GROUPS } from '@/shared/utils/themeVariables';

import {
  colorOf,
  contrastRatio,
  describeDefects,
  inspectThemeFile,
  readGlobalVars,
  readThemeFiles,
  splitBlocks,
  themeFileFromSource,
} from './themeCss';

/**
 * 主题文件完整性守卫：`src/styles/themes/*.css` ↔ 变量契约。
 *
 * ## 判据
 *
 * `themes/` 下的每个 `.css` **都是主题**（不按变量数、不按有没有 accent 色判断），
 * 都必须覆盖契约里的全部变量。缺任何一个 → `var(--x)` 回退为继承色，
 * 表现为「颜色静默失效」，没有任何报错（2026-08-28 事故）。
 *
 * ## 为什么判据是纯函数
 *
 * 判据曾写成测试内的 `themes.flatMap(...)`，配套「反证」用例却自己用
 * `THEME_VARIABLES.filter(...)` 重算一遍 —— **没走判据代码路径**，
 * 于是它无论判据怎么写都会绿（假测试）。
 *
 * 现在判据是 `themeCss.ts` 的 `inspectThemeFile()`，下面的坏数据用例
 * 与真实文件断言走**同一个函数**，假绿无从产生。
 */

// 文件只读一次 —— 多个 describe 共用同一份快照
const themeFiles = readThemeFiles();
const globalVars = readGlobalVars();

describe('主题文件 ↔ 变量契约', () => {
  it('解析到 themes/ 下的全部主题文件', () => {
    // 健全性：防目录路径写错导致 themes 为空、下面所有断言空转
    expect(themeFiles.length).toBeGreaterThanOrEqual(5);
    expect(themeFiles.map((t) => t.file)).toEqual(
      expect.arrayContaining([
        'dark.css',
        'light.css',
        'one-dark-pro.css',
        'claude.css',
        'classic-dark.css',
      ]),
    );
  });

  it('每个主题文件都没有缺陷（变量完整 / 无未登记 / 有 color-scheme）', () => {
    const failures = themeFiles.flatMap((f) =>
      describeDefects(f, inspectThemeFile(f, THEME_VARIABLES)),
    );
    expect(failures).toEqual([]);
  });
});

/**
 * 坏数据用例 —— 直接喂 `inspectThemeFile`，走与真实文件相同的代码路径。
 *
 * 这些用例取代了此前「在对话里临时写 bash/python 脚本注入坏主题」的验证方式。
 * 那种脚本不进仓库、无法 review，其中一次把 `s[:-2]`（删尾部空行）当成
 * 「删闭合括号」，得出了「语法错误能容忍」的错误结论。
 */
describe('判据对坏主题的识别', () => {
  const N = THEME_VARIABLES.length;

  /**
   * 一份完整合规的主题源码：取自真实 `dark.css`，把主题名换成 `fixture`。
   *
   * **必须用 `replaceAll`** —— `dark.css` 里 `:root[data-theme="dark"]` 出现两次
   * （`color-scheme` 块 + 变量块）。用 `replace()` 只换第一处，第二处仍是
   * `data-theme="dark"`，会让下面「选择器写错」用例的 replaceAll 漏掉它、
   * 该块继续被解析到 → 用例假绿。
   */
  const validSource = readFileSync(resolve(__dirname, '../themes/dark.css'), 'utf8').replaceAll(
    'data-theme="dark"',
    'data-theme="fixture"',
  );

  it('fixture 源码本身不含原主题名（防替换漏掉）', () => {
    expect(validSource).not.toContain('data-theme="dark"');
  });

  it('完整主题无缺陷（基线，证明下面的坏数据确实只差在坏点上）', () => {
    const defects = inspectThemeFile(themeFileFromSource(validSource), THEME_VARIABLES);
    expect(describeDefects(themeFileFromSource(validSource), defects)).toEqual([]);
  });

  it('空文件：报出全部变量缺失且缺 color-scheme', () => {
    const f = themeFileFromSource('');
    const d = inspectThemeFile(f, THEME_VARIABLES);
    expect(d.missingVars).toHaveLength(N);
    expect(d.unknownVars).toEqual([]);
    expect(d.lacksColorScheme).toBe(true);
  });

  it('只有 color-scheme：仍报出全部变量缺失', () => {
    const f = themeFileFromSource(':root[data-theme="x"] {\n  color-scheme: dark;\n}\n');
    const d = inspectThemeFile(f, THEME_VARIABLES);
    expect(d.missingVars).toHaveLength(N);
    expect(d.lacksColorScheme).toBe(false); // color-scheme 本身是有的
  });

  it('只写了 1 个变量：报出 N-1 个缺失', () => {
    const f = themeFileFromSource(
      ':root[data-theme="x"] {\n  color-scheme: dark;\n  --bg-primary: #000;\n}\n',
    );
    const d = inspectThemeFile(f, THEME_VARIABLES);
    expect(d.missingVars).toHaveLength(N - 1);
    expect(d.missingVars).not.toContain('--bg-primary');
  });

  it('缺一个变量：精确指出是哪一个', () => {
    const broken = validSource.replace(/^\s*--switch-track:.*$/m, '');
    expect(broken).not.toBe(validSource); // 确认替换真的生效（防 case 写错导致空转）
    const d = inspectThemeFile(themeFileFromSource(broken), THEME_VARIABLES);
    expect(d.missingVars).toEqual(['--switch-track']);
  });

  it('变量名拼错：同时报「缺正确名」与「多错名」', () => {
    const broken = validSource.replace('--cm-bracket:', '--cm-brackets:');
    expect(broken).not.toBe(validSource);
    const d = inspectThemeFile(themeFileFromSource(broken), THEME_VARIABLES);
    expect(d.missingVars).toEqual(['--cm-bracket']);
    expect(d.unknownVars).toEqual(['--cm-brackets']);
  });

  it('多出未登记变量：报进 unknownVars', () => {
    const broken = validSource.replace('--bg-primary:', '--bg-bogus: #000;\n  --bg-primary:');
    expect(broken).not.toBe(validSource);
    const d = inspectThemeFile(themeFileFromSource(broken), THEME_VARIABLES);
    expect(d.unknownVars).toEqual(['--bg-bogus']);
    expect(d.missingVars).toEqual([]);
  });

  it('缺 color-scheme：只报缺 color-scheme，变量不受影响', () => {
    const broken = validSource.replace(/\n\s*color-scheme:[^;]+;/, '');
    expect(broken).not.toBe(validSource);
    const d = inspectThemeFile(themeFileFromSource(broken), THEME_VARIABLES);
    expect(d.lacksColorScheme).toBe(true);
    expect(d.missingVars).toEqual([]);
  });

  it('选择器写错（漏 :root）：解析不到变量块，等价于空文件', () => {
    // `splitBlocks` 只认 `^:root`；选择器写错会让整个块被漏掉。
    // 真实影响 = 该主题一个变量都没有 → 全部报缺。
    //
    // 注意必须用 replaceAll：同一个选择器在一个文件里出现两次
    // （color-scheme 块 + 变量块），只换第一处时第二个块仍能被解析到 ——
    // 那会让本用例假绿。
    const broken = validSource
      .replaceAll(':root[data-theme="fixture"]', '[data-theme="fixture"]')
      .replaceAll(':root:not([data-theme])', '.fallback');
    // 显式确认两次替换都生效（防「替换没匹配上」导致断言空转）
    expect(broken).not.toBe(validSource);
    expect(broken).not.toContain(':root[');
    expect(broken).not.toContain(':root:not(');

    const d = inspectThemeFile(themeFileFromSource(broken), THEME_VARIABLES);
    expect(d.missingVars).toHaveLength(N);
  });

  it('缺闭合括号：块解析失败，同样报出全部变量缺失', () => {
    // 这条是那次「假绿」的正身：闭合括号缺失必须被识别。
    // 构造方式显式断言「确实删掉了 }」，避免再写出删空行的错误脚本。
    const idx = validSource.replace(/\s+$/, '').lastIndexOf('}');
    expect(idx).toBeGreaterThan(-1);
    const broken = validSource.slice(0, idx) + validSource.slice(idx + 1);
    expect(broken.length).toBe(validSource.length - 1);
    expect(broken.replace(/\s+$/, '').endsWith('}')).toBe(false);

    const d = inspectThemeFile(themeFileFromSource(broken), THEME_VARIABLES);
    expect(d.missingVars).toHaveLength(N);
  });
});

/**
 * `base/variables.css` **有意**提供的兜底变量。
 *
 * 判据：未知 `data-theme`（或用户自定义主题没覆盖到的）时，这些必须有值，
 * 否则界面完全无色 / 无字体色。**这是一份显式决策，不是推断出来的**。
 *
 * 2026-10-28 教训：上一版只按「组」猜测（cm + git-status），把 `--mono-fg` /
 * `--mono-fg-dim` / `--border-subtle` 的兜底校验漏掉了 —— 它们属于 `text` 组，
 * 而 `text` 组里其余变量（`--text-primary` 等）**不该**在 :root 兜底（那是主题职责）。
 * 按组推断无法表达这种区内差异，必须逐项列出。
 */
const GLOBAL_FALLBACK_TOKENS: readonly string[] = [
  ...THEME_VARIABLE_GROUPS.codeMirror,
  ...THEME_VARIABLE_GROUPS.gitStatus,
  '--mono-fg',
  '--mono-fg-dim',
  '--border-subtle',
];

describe('base/variables.css 兜底', () => {
  it('提供每一个「有意兜底」的变量', () => {
    const missing = GLOBAL_FALLBACK_TOKENS.filter((token) => !globalVars.vars.has(token));
    expect(missing).toEqual([]);
  });

  it('不兜底其它契约变量（那是 themes/ 的职责）', () => {
    // 反向闭环：variables.css 里出现的契约变量不得超出上面的白名单，
    // 否则会变成「第二份需要与主题同步的定义」。
    const allowed = new Set(GLOBAL_FALLBACK_TOKENS);
    const leaked = THEME_VARIABLES.filter(
      (token) => !allowed.has(token) && globalVars.vars.has(token),
    );
    expect(leaked).toEqual([]);
  });

  it('定义 color-scheme 默认值（未设 data-theme 时的兜底）', () => {
    expect(globalVars.raw).toContain('color-scheme:');
  });
});

describe('Tailwind 桥接', () => {
  const bridge = readFileSync(resolve(__dirname, '../base/tailwind.css'), 'utf8');

  it('把每个 git-status token 映射为 utility 类', () => {
    // 缺一条桥接 ⇒ text-git-status-* 静默不生成（与红线 14「声明了不生效」同型）。
    const missing = THEME_VARIABLE_GROUPS.gitStatus.filter(
      (token) => !bridge.includes(`--color-${token.slice(2)}:`),
    );
    expect(missing).toEqual([]);
  });

  it('把 switch-track 映射为 utility 类', () => {
    expect(bridge).toContain('--color-switch-track:');
  });
});

describe('Switch 轨道对比度', () => {
  // 2026-10-27 用户反馈「特别在 claude、light 主题下面特别明显的不协调」：
  // 未勾选态轨道曾复用 --bg-tertiary（表面层级色），与海面对比只有
  // 1.08（light）/ 1.11（claude）—— 轨道消失，只剩一颗深色圆球漂着。
  // 判据不是「值存在」而是「真的成形」，且必须对**每个主题文件**生效。
  it('每个主题的 --switch-track 与 --bg-primary 对比度 ≥ 1.5', () => {
    const failures: string[] = [];
    for (const theme of themeFiles) {
      const bg = colorOf(theme, '--bg-primary');
      const track = colorOf(theme, '--switch-track');
      if (!bg || !track) {
        failures.push(`${theme.file} 颜色无法解析`);
        continue;
      }
      const ratio = contrastRatio(bg, track);
      if (ratio < 1.5) {
        failures.push(`${theme.file} 轨道对比 ${ratio.toFixed(2)} < 1.5（轨道会消失）`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('CSS 解析器自检', () => {
  it('能处理跨行选择器与同文件多块', () => {
    const css = [
      ':root[data-theme="a"],',
      ':root:not([data-theme]) {',
      '  color-scheme: dark;',
      '}',
      ':root[data-theme="a"],',
      ':root:not([data-theme]) {',
      '  --bg-primary: #000;',
      '  --text-primary: #fff;',
      '}',
    ].join('\n');
    const blocks = splitBlocks(css);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.vars).toEqual([]); // color-scheme 块无变量
    expect(blocks[1]?.vars).toEqual(['--bg-primary', '--text-primary']);
    // 按文件合并后，两块并集的变量才是该主题的完整定义
    expect(new Set(blocks.flatMap((b) => b.vars)).size).toBe(2);
  });
});
