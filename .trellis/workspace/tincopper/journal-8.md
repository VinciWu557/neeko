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

用户问「这个防护能防得住吗」。实测答案是**防不住**，于是删掉了整套 ESLint 规则，
判据回到护栏 —— 并补上真正的盲区（CSS 侧），此前零覆盖。

### 实测：规则只能看到 JSX 字面量

把 7 种规避写法写成测试（`it.fails` 记录）：

```
Tests  22 passed | 7 expected fail (29)
```

| 规避写法 | 结果 |
| --- | --- |
| 模板字符串 `` className={`text-text-muted`} `` | ❌ 漏 |
| 模板串拼接 | ❌ 漏 |
| 变量引用 | ❌ 漏 |
| 常量对象 `STY.m` | ❌ 漏 |
| **共享函数返回 `optionSecondary()`** | ❌ 漏 |
| 内联 `style={{ color }}` | ❌ 漏 |
| **CSS 文件** | ❌ 漏 |

### 决定性的一条：规则与正确写法互斥

`optionSecondary()` 有 10 处调用，它返回的 class 串**规则完全看不到**。

而那 7 处 bug 修完后**全部改用 `optionSecondary()`** —— 规则恰好对它们失明。
7 处里有 **2 处在 CSS**（`agent.css` / `base.css`），规则只扫 `.tsx?`，从来就看不到。

> **规则最该防的地方它防不住，能看到的地方又已经没人那样写。**

上一轮我判断「规则有价值，建议保留」——**那个判断是错的**，
因为当时没意识到它与本轮引入的共享函数互斥。

### 顺带修掉两个「测试自己的假绿」

1. `lintSource` 直接数 `messages.length` —— 解析失败会产生一条 `ruleId: null` 的
   parse error，被当成「规则抓到了」。拿 CSS 内容喂 ts parser 得到 1 条 parse error，
   误判成「规则能扫 CSS」。**改成按 `ruleId` 过滤。**
2. 规则注册名是 `r`，与真实规则名不一致，让上面的过滤无从写起。改用 `RULE_ID` 常量。

这与用户上一轮的批评同源：**辅助代码不严谨 → 结论错误**。

### 执行：删规则 + 补真盲区

**删除**：
- `tools/eslint-rules/`（3 个文件：规则 313 行 + 插件 22 行 + package.json）
- `src/ui/__tests__/accentForegroundRule.test.ts`（175 行 / 29 用例）
- `.eslintrc.cjs` 的 `plugins: ['neeko']` 与规则条目
- `package.json` 的 `"eslint-plugin-neeko": "file:tools/eslint-rules"`
- `pnpm-lock.yaml` 的 2 处 entries
- `lint:fe` 恢复为 `eslint src/ --cache --cache-strategy content && pnpm type-check`

**补上**：护栏第 5 条判据（`check_ui_style_tokens`）。

### 判据 5 的设计

```python
RE_SOLID_ACCENT_BG = re.compile(
    r"background(?:-color)?\s*:\s*var\(\s*--(?:accent-(?:blue|green|yellow|red|orange|brick)|destructive)\s*\)"
)
RE_ON_ACCENT_FG = re.compile(r"var\(\s*--text-on-accent\s*\)(?:\s*!important)?")
RE_FG_DECL = re.compile(r"(?<!background-)(?<!-)\bcolor\s*:\s*([^;]+);")
RE_CSS_RULE_BLOCK = re.compile(r"([^{}]+)\{([^{}]*)\}")
```

**只认「值就是 `var(--accent-*)`」的实底**。以下都不算，不得误报：

```css
background: color-mix(in srgb, var(--accent-blue) 32%, transparent)   /* 半透明 */
background-color: rgba(var(--accent-blue-rgb), 0.28)                  /* 半透明 */
```

`editor.css` 有 5 处这种写法 —— 半透明底 + 普通文字色是**对的**。
（第一版把 `color: var(--text-on-accent);` 整串拿去匹配值正则，误报 3 处，已修。）

`(?<!background-)` 排除 `background-color:` 里的 `color` —— 否则每个实底都会被自己误判。

### 测试（8 条新增，含 1 变异）

| 用例 | 内容 |
| --- | --- |
| 历史 bug 正身 ×2 | `agent.css` 的 `--text-primary`、`base.css` 的 `#fff` |
| 反证 ×4 | 正确写法（含 `!important`）/ 半透明 ×3 / `background-color` 不误读 / 无 accent 底的块 |
| 回归 | 规则块包在 `@layer` 里也要检查 |
| 变异 | `RE_SOLID_ACCENT_BG` 恒不匹配 → 必绿 |

### 真实仓库验证

注入 2026-10-27 的历史 bug 原形到 `agent.css`：

```
- src/styles/components/agent.css:68: accent 实底上的前景色应为 var(--text-on-accent)，
  实际是 `var(--text-primary)`（.agent-bar-btn.selected）
```

恢复后 0 违规。

### 产出

| 文件 | 改动 |
| --- | --- |
| `tools/eslint-rules/**` | **删除**（357 行 + file: 依赖） |
| `src/ui/__tests__/accentForegroundRule.test.ts` | **删除**（175 行 / 29 用例） |
| `tools/guards/checks/check_ui_style_tokens.py` | +判据 5（CSS 侧）；`SCOPES` 拆 `TSX_SCOPES` / `CSS_SCOPES` |
| `tools/guards/tests/test_check_ui_style_tokens.py` | 18 → **26** 用例 |
| `.eslintrc.cjs` · `package.json` · `pnpm-lock.yaml` | 移除插件与 `file:` 依赖 |
| `design-tokens.md` · `implement.md` · `styles/README.md` | 同步「规则已删、判据回落护栏」 |

### Testing

- [OK] 护栏单测 26/26（含变异）
- [OK] 护栏全部 702 用例通过
- [OK] 真实仓库注入历史 bug → 精准命中；恢复 → 0 违规
- [OK] `check_ui_style_tokens`：602 tsx + 22 css / 0 违规
- [OK] `pnpm check:quick` 全绿：32 条护栏
- [OK] lockfile 已无 `eslint-plugin-neeko`

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


## Session 362: 校准 one-dark-pro 主题的 chrome 表面色
<!-- trellis-session: v=2 fp=b212369f6ed35cb5 -->

**Date**: 2026-10-28
**Task**: 校准 one-dark-pro 主题的 chrome 表面色
**Branch**: `main`

### Summary

语法色本就准确，问题在 chrome：主海面用了 VS Code 的 sidebar 色、自造渐变、hover 用了选区色、次级/元数据文字过暗。按 One Dark Pro workbench 键重映射整条表面阶梯，渲染对比图定稿后复算全部对比度。

### Main Changes

- themes/one-dark-pro.css：bg-primary #21252b→#282c34（editor.background），浮岛 #2c313a→#333842（岛/海从 1.07 恢复到 1.19），区块 #333842→#383e4a，hover #3e4451→#434852，selected #464d5b→#4d5666，border #363b46→#3e4451，text-secondary #828997→#9da5b4，text-muted #5c6370→#7f848e；bg-gradient start/end 统一为 #282c34（去掉自造 #23272e）
- themes/one-dark-pro.css：switch-track #3f4349→#4d5666（海面提亮后对比会跌到 1.41 < 1.5），terminal-selection 改用光标蓝 #528bff
- 同步实测数字：design-tokens.md（坑 8 表 + switch-track 推导表 + 滑块表）、Switch.test.tsx、Radio.tsx 的注释表格

### Git Commits

(No commits - planning session)

### Testing

- [OK] pnpm vitest run themeTokens / Switch / Radio —— 42 passed
- [OK] pnpm check:quick —— 13 条护栏 + 改动文件单测全绿

### Status

[OK] **Completed**

### Next Steps

- 打开 pnpm tauri dev 实机确认浮岛/区块层级与悬停观感（静态截图已确认，未在真机看）
- 若实机觉得岛内区块太靠色，可再抬一档 --bg-tertiary
