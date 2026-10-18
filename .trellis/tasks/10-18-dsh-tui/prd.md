# PRD — DSH 完整 TUI（基于 pi-tui，接入 dsh 0.2.x）

> 用户决策：方案 B（自研适配层）+ 参考方案 A 的代码实现。
> 放 `packages/dsh-neeko` 下（与既有桥同包）。前置事实来自 `10-17-dsh-neeko-bridge-fix`
> 的调研：dsh 运行时是 `0.2.0-rc.2`，桥已修复可用。

## Goal

`dsh --profile neeko --tui`（或等价入口）能进入完整交互式终端 UI：
流式渲染助手输出、行内编辑、审批 / 提问交互、会话恢复、斜杠命令 ——
即 `@xmoon76/dsh-pi-tui` 在 0.1.x 上提供的体验，在 0.2.x 上重建。

## 为什么可行（调研结论，非假设）

### 1. 输入编码不是本任务的工作量 —— pi-tui 提供

`@earendil-works/pi-tui@1.3.0`（npm 可装，已实测 `pnpm add` 成功）导出：

| 能力 | 导出 | 说明 |
| --- | --- | --- |
| 输入解码 | `StdinBuffer` / `ProcessTerminal` / `resolveEscapeTimeoutMs` | escape 重组（默认 10ms / SSH 100ms / `PI_TUI_ESC_TIMEOUT` 可覆盖） |
| 键盘协议 | `matchesKey` / `parseKey` / `Key` / `isKeyRelease` / `isKittyProtocolActive` | Kitty 协议协商 + 修饰键组合 |
| 渲染 | `TuiMainScreen` / `TuiAltScreen` / `Container` / `VStack` | 差分渲染 |
| 组件 | `Editor` / `Markdown` / `SelectList` / `ScrollView` / `Loader` / `Text` / `Box` | 全套 UI 组件 |
| 其他 | `keybindings` / `autocomplete` / `fuzzyMatch` / Markdown(LaTeX/图片) | 键位表 / 命令补全 |

### 2. 参考实现结构已拆解

`@xmoon76/dsh-pi-tui@0.1.1` 的 dist 结构（region 边界实测）：

```
10,664 行  ../pi-tui/dist/index.mjs   ← pi-tui 原样内联（用 npm 版替代，不 vendor）
 ~4,500 行  src/* 13 个模块           ← dsh 适配层（本任务要按 0.2.x 重写的部分）
    1,284  src/working.ts            ← 主 TUI（流式渲染 + 键位路由 + 全屏预览）
      953  src/commands.ts           ← 斜杠命令
      840  src/index.ts              ← Cordis 插件入口 + agent 生命周期
      458  src/transcript.ts         ← 转录窗口化（WINDOW_TURNS=15，老轮次折叠）
      218  src/present.ts            ← 工具呈现
      193  src/stats.ts              ← token 统计
      144  src/theme.ts              ← 主题
      123  src/model-menu.ts
      109  src/sessions.ts
      100  src/context.ts
       51  src/search.ts
       50  src/diff.ts
```

### 3. 接线模式与既有桥同构（已验证）

参考实现的核心接线（`agents.create/resume` + `setup` 回调 + `whenIdle` + `defaultModel.currentSelection()`）
与 `dsh-neeko/src/index.ts` 的 `doActivate()` 完全同构 —— 本仓已有一份跑通的 0.2.x 接线。

### 4. 已知风险（从参考实现预读）

- 参考实现 pin 0.1.x；其 `session.events`（0.2 已删）、`recomposeBlank` 用
  `agent.session.events.some(...)`、`snapshotEvents` 已标 deprecated —— 全部要按 0.2.x 契约写。
- 参考实现依赖 26 个 peer；**本任务不复制这个面**，只依赖实际用到的（预计 ≤8 个）。

## Requirements

### R1 位置与形态

- R1.1 代码落 `packages/dsh-neeko/src/tui/`（与桥同包，复用其构建 / 门禁 / profile 装配）。
- R1.2 新增 pi-tui 依赖（`@earendil-works/pi-tui@^1.3.0`），作为普通 dependency。
- R1.3 入口形态：`dsh --profile neeko --tui`（startup.ts 加 flag）→ 走 TUI runner；
  默认（无 flag）保持桥形态不变。
- R1.4 profile 装配复用 `cordis.patch.yml`：TUI 行与桥行并列，共享 `neekoStartup` 服务。

### R2 核心 TUI 面（MVP 边界）

- R2.1 **渲染**：`TuiMainScreen` + `Editor` + 消息流（用户 / 助手 Markdown / 工具调用 / 工具结果）。
- R2.2 **流式**：`agent/assistant-stream` 的 `start`/`chunk`/`end` 帧 → 助手气泡增量渲染
  （≥50ms 合帧，参考实现的 `REPAINT_FLUSH_MS=50`）。
- R2.3 **输入**：Editor 组件原生（多行、历史、粘贴）+ 提交 → `agent.prompt()`。
- R2.4 **审批**：`approval/request` waterfall → 行内 SelectList（allow / reject）→ resolve。
- R2.5 **提问**：`user-questions/request` waterfall → 行内问答 UI → `AskUserQuestionAnswer` 形状
  （沿用桥的 `canAnswerQuestions` / 等待器基建 —— 已测过的代码直接复用）。
- R2.6 **状态**：`agent/status` → working indicator（thinking / executing / awaiting_human）。
- R2.7 **会话**：`--session <id>` 恢复；历史从 `snapshotEvents()` 折叠（复用桥的 `buildHistory`）。

### R3 边界（明确不做）

- R3.1 不做斜杠命令注册到 DSH `CommandRuntime`（用 pi-tui 的 autocomplete 自定义即可）。
- R3.2 不做 agent preset 切换（`agentPresets`/`recomposeBlank`）—— 参考实现有，MVP 不要。
- R3.3 不做 alt-screen 全屏预览 / 外部编辑器 / 搜索 overlay。
- R3.4 不做 token 统计条、主题系统、模型菜单。
- R3.5 不做多会话切换 UI。
- （R3 项全部是参考实现已解决、后续可增量加的 —— 记入「后续」清单，不是「不做」。）

### R4 门禁

- R4.1 `packages/dsh-neeko` 门禁豁免不变，验证入口 `prepublishOnly`。
- R4.2 TUI 代码可测面（翻译 / 折叠 / 状态机 / 键位路由）必须有单测；
  渲染冒烟用真实终端跑（人工项，如 AC6）。
- R4.3 不引入 `dsh-pi-tui` 作为依赖 —— 参考其源码（GitHub `XMoon/dsh-pi-tui`），不依赖它。

## Acceptance Criteria

- [ ] **AC1 入口**：`dsh --profile neeko --tui` 进入 TUI（清屏、光标受控、可输入）；
  无 `--tui` 时桥行为与迁移前完全一致（零回归）。
- [ ] **AC2 流式**：真实对话中助手文本增量出现（非整段跳出），思考与正文分离显示。
- [ ] **AC3 工具**：工具调用 / 结果在转录中成对出现，失败态可见。
- [ ] **AC4 审批**：真实触发审批时行内出现选项，选择后 agent 继续；拒绝也生效。
- [ ] **AC5 提问**：`ask_user_question` 触发行内问答，答案回传后 agent 继续。
- [ ] **AC6 会话**：`--session <id>` 恢复后历史完整呈现，可继续对话。
- [ ] **AC7 桥零回归**：桥侧既有 68 测试全绿；桥的真实机验证（health / WS / session.init）复跑通过。
- [ ] **AC8 门禁**：`prepublishOnly` 全绿。
- [ ] **AC9 契约纪律**：不引用 0.1.x API（`session.events`、`registerProvider`、`assistant/chunk`）；
  实时 delta 只来自 `agent/assistant-stream`。

## 明确不在本任务范围

- Neeko 桌面侧的 DSH 接入（`10-16-notify-dsh` 的 U7 归属定案）。
- R3 列出的参考实现高级特性（preset 切换 / alt-screen / 搜索 / 主题 / 多会话）。
- 根仓 `src-tauri/**` / `src/**`。
- 把 TUI 发布为独立 npm 包（同包即可）。

## 风险

| 风险 | 对策 |
| --- | --- |
| `agent.prompt()` 等入口在 0.2.x 的真实签名与预期不符 | 写码前读 `dsh-agent` `.d.ts` 确认（本任务调研已确认 create/resume/whenIdle/get/list） |
| pi-tui 1.3.0 与内联版（参考实现用的 fork）行为差异 | 五个 "local rendering fixes" 逐条核对；行为差异记录到 design，必要时提 patch |
| 参考实现的 `transcript.ts` 窗口化逻辑复杂（458 行） | MVP 先全量渲染，窗口化作为第二步（性能问题出现再做） |
| TUI 与桥共存导致 profile 装配冲突 | 两者共享 `neekoStartup` 服务，config 用 `mode` 区分；patch 行并列（参考实现同构） |
| 无头环境（CI）跑不了渲染 | 渲染相关不做自动化断言，翻译/折叠/状态机做单测（R4.2） |
