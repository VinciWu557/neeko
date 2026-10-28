# Journal - tincopper (Part 8)

> Continuation from `journal-7.md` (archived at ~2000 lines)
> Started: 2026-10-28

---



## Session 359: styles 目录规范化：motion 层 + form.css 转 Tailwind + 死代码清理
<!-- trellis-session: v=2 fp=95855f3ae883736e -->

**Date**: 2026-10-28
**Task**: styles 目录规范化：motion 层 + form.css 转 Tailwind + 死代码清理
**Branch**: `main`

### Summary

用户指出：**「验证脚本本身写错，那这个脚本本身就不应该存在」**。

这是对验证纪律的根本批评。我把判据从「测试内 inline 逻辑 + 对话里临时脚本」
改成了「纯函数 + 永久坏数据用例」。

### 问题：三重不牢靠

**① 判据写在测试里，无法被坏数据驱动**

```ts
// 测试内 inline
const missing = themes.flatMap(({ file, vars }) =>
  THEME_VARIABLES.filter((token) => !vars.has(token)).map(...));
expect(missing).toEqual([]);
```

**② 配套的「反证」是假测试**

```ts
it('新增一个不完整的主题文件会被抓到', () => {
  const stub = { vars: new Set(['--bg-primary']) };
  const missing = THEME_VARIABLES.filter((t) => !stub.vars.has(t));  // ← 自己重算一遍
  expect(missing.length).toBe(THEME_VARIABLES.length - 1);
});
```

它没走判据代码路径 —— 判据改成任何样子它都绿。

**③ 验证靠对话里的临时脚本**

8 种坏主题形态是在 bash heredoc 里 inline 写 python 注入的。不进仓库、
无法 review、无法复用。其中一次：

```python
pathlib.Path('bad.css').write_text(s[:-2])   # 想删闭合括号，实际删的是尾部空行
```

于是得出「语法错误也能被容忍」的**错误结论**，下一轮靠重做才发现是脚本错。

### 修复：判据抽成纯函数 + 永久坏数据用例

`themeCss.ts` 新增：

```ts
export interface ThemeFileDefects {
  missingVars: string[];
  unknownVars: string[];
  lacksColorScheme: boolean;
}

export function inspectThemeFile(file: ThemeFile, contract: readonly string[]): ThemeFileDefects;
export function describeDefects(file: ThemeFile, defects: ThemeFileDefects): string[];
export function themeFileFromSource(source: string, name?: string): ThemeFile;
```

`themeTokens.test.ts` 的「判据对坏主题的识别」新增 **10 条永久用例**，
每条都走 `inspectThemeFile()`（与真实文件断言同一个函数）：

| 坏形态 | 断言 |
| --- | --- |
| 完整主题（基线） | 无缺陷 —— 证明下面的用例只差在坏点上 |
| 空文件 | 缺全部变量 + 缺 color-scheme |
| 只有 color-scheme | 缺全部变量，但不缺 color-scheme |
| 只写 1 个变量 | 缺 N-1 个，且不含 `--bg-primary` |
| 缺一个变量 | 精确指出 `--switch-track` |
| 变量名拼错 | 同时报「缺正确名」+「多错名」 |
| 多出未登记变量 | 报进 `unknownVars` |
| 缺 color-scheme | 只报缺 color-scheme，变量不受影响 |
| 选择器写错（漏 `:root`） | 等价空文件 |
| **缺闭合括号** | 等价空文件 ← **那次假绿的正身** |

### 写这些用例时又踩到两次同类陷阱（都被显式断言抓到）

**陷阱 1**：`validSource` 构造用 `.replace('data-theme="dark"', ...)` —— 只换第一个，
而 `dark.css` 里该选择器出现两次（color-scheme 块 + 变量块）。导致「选择器写错」
用例的 replaceAll 漏掉第二处、该块继续被解析 → 用例假绿。
**修**：改 `replaceAll`，并加断言 `expect(validSource).not.toContain('data-theme="dark"')`。

**陷阱 2**：`broken` 构造用 `.replace(...)` 同样只换第一个。
**修**：改 `replaceAll` + 显式断言 `expect(broken).not.toContain(':root[')`。

这两次都是**自己加的显式断言抓到的**，不是靠跑测试碰巧发现 ——
这正是「断言替换真的生效」这条纪律的价值。

### 变异验证（改生产代码，看测试反应）

| 变异 | 结果 |
| --- | --- |
| `inspectThemeFile` 恒返回无缺陷 | **9 failed** |
| 只检查契约前 10 个变量 | **7 failed** |
| `lacksColorScheme` 恒 false | **2 failed** |

还原后 20/20 绿。变异点是显式 assert 找到的（防止「改了但没改到」）。

### 文档

`src/styles/README.md` 新增一段硬指令：

> **不要用临时脚本验证判据。** 任何判据的坏数据用例都写进测试文件 ——
> 可复现、可 review、改了判据会立刻知道。

### 产出

| 文件 | 改动 |
| --- | --- |
| `src/styles/__tests__/themeCss.ts` | +判据纯函数 `inspectThemeFile` / `describeDefects` / `themeFileFromSource` |
| `src/styles/__tests__/themeTokens.test.ts` | 判据改为调纯函数；+10 条坏数据用例；删假反证 |
| `src/styles/README.md` | +「不要用临时脚本验证判据」 |
| `design-tokens.md` | 指向永久用例 |

### Testing

- [OK] `themeTokens.test.ts` 20/20、`themeContract.test.ts` 7/7
- [OK] **变异验证 ×3**（9 / 7 / 2 failed）
- [OK] `pnpm check:quick` 全绿：32 条护栏

### Status

[OK] **Completed**


### Git Commits

(No commits - planning session)

### Status

[OK] **Completed**


## Session 360: 修复审核发现的 1 Block + 3 Warning + 2 Nit（主题校验后门）
<!-- trellis-session: v=2 fp=5245a9180b0d226e -->

**Date**: 2026-10-28
**Task**: 修复审核发现的 1 Block + 3 Warning + 2 Nit（主题校验后门）
**Branch**: `main`

### Summary

Session summary was not supplied.

### Git Commits

(No commits - planning session)

### Status

[OK] **Completed**


## Session 361: 删除 ESLint 规则，判据回归护栏（判据 5：CSS 侧真盲区）
<!-- trellis-session: v=2 fp=505e1492ca353b6e -->

**Date**: 2026-10-28
**Task**: 删除 ESLint 规则，判据回归护栏（判据 5：CSS 侧真盲区）
**Branch**: `main`

### Summary

Session summary was not supplied.

### Git Commits

(No commits - planning session)

### Status

[OK] **Completed**
