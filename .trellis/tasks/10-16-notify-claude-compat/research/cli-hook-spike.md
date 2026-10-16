# Step 0 Spike — CLI hook 面实测（U1–U4）

> 任务：`10-16-notify-claude-compat`，Step 0（阻塞 gate）。
> 日期：2026-10-16。方法：本机二进制 / 配置文件 / 已装 npm 包源码静态取证。
> **不猜**：每条结论都给出可复核的证据（文件路径 / 命令 / 字符串）。

---

## U1 — OMP 是否支持 `ui_prompt_start`？

**结论：不支持。OMP 需要 pi 模板的变体（去掉 `ui_prompt_start` 那条腿）。**

证据（三路一致）：

| 取证 | 结果 |
|---|---|
| `strings -a /opt/homebrew/Cellar/omp/18.10.3/bin/omp \| grep ui_prompt` | **0 命中**（`ui_` 前缀只有 `ui_chat_log` / `ui_log_events`，非事件名） |
| `strings \| grep -E 'withUIPrompt\|emitUIPromptEvent\|UIPromptKind\|uiPromptDepth'` | **全部 0 命中** —— OMP 未移植 pi 的 UI-prompt 包装层 |
| OMP 事件名全集（引号形态枚举） | `after_provider_response, agent_end, agent_start, before_agent_start, before_provider_request, cache_warming_decision, context, input, message_end, message_start, message_update, resources_discover, session_shutdown, session_start, tool_call, tool_execution_end, tool_execution_start, tool_execution_update, tool_result, turn_end, turn_start, user_bash` —— **无 `ui_prompt_start` / `ui_prompt_end`** |

对照（pi 侧权威来源，`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:1081`）：

```ts
export type ExtensionEvent = ... | UIPromptStartEvent | UIPromptEndEvent | ...
```

pi 的 `ExtensionRunner.wrapUIPromptContext` / `withUIPrompt` / `emitUIPromptEvent`
（`dist/bundle/cli.js`）实证该事件由 `select`/`confirm`/`input`/`editor`/`custom` 包装触发。

**影响**：
- OMP 的「等待输入」腿**不能**靠 `ui_prompt_start`；
- 但 OMP **有 `tool_call`**（pi 模板的「等待审批」腿靠 `tool_call` 里的 ask 类工具），
  故「等待审批」腿仍可用；
- 「等待输入」腿在 OMP 上：**可用的替代是 `input` 事件**（OMP 事件表含 `input`，
  pi 的 `InputEvent` 语义是「用户输入被提交」，方向相反 —— 是**用户已输入**而非**等待输入**，
  故**不能**用作「等待输入」信号）。
- **决定**：OMP 用 pi 模板的变体 —— 保留 `agent_end` + `tool_call`，**删除 `ui_prompt_start` 段**。
  变体模板仍是 `include_str!` 的独立文件（不是运行时分支），保持 shim/模板「零 CLI 分支」原则。

**未验证（登记为实施期风险）**：OMP 对**未注册**事件名调 `pi.on()` 的行为
（OMP 的 `handlers.get(...)` 是 `Map`，未命中返回 `undefined`；但 `on()` 注册时是否校验事件名
未取证）。因 OMP 变体不再注册 `ui_prompt_start`，该风险**不影响本任务**。

---

## U2 — `node` 是否可作为 shim 运行时前提？

**结论：本机有 node（v24.17.0），但 Codex 用户机不能假设 —— shim 必须做 node 缺失的显式降级。**

证据：

```bash
$ command -v node   → /Users/tomgs/.local/share/fnm/node-versions/v24.17.0/installation/bin/node
$ node --version    → v24.17.0
$ command -v bun    → /opt/homebrew/bin/bun     # 存在，但不保证
```

物理事实：**Codex 是 Rust 二进制**（`/opt/homebrew/Caskroom/codex/0.162.1/bin/codex`，
246MB，无 JS runtime 依赖）。Claude / CodeBuddy / Qoder 都是 Node/npm 系
（`codebuddy` = npm 包 `@tencent-ai/codebuddy-code`；`qodercli` = bun 编译产物），
**它们的用户机必然有 node**。

**影响与决策**：
- 对 **Claude / CodeBuddy / Qoder**（本任务范围）：node 前提**成立**（它们自己就跑在 node 上）。
- 对 **Codex**（`10-16-notify-codex`）：**不成立** → 该子任务已登记 R3.2/R3.3 的降级路径。
- `platform/hook_command.rs` 的 `render_report_command` 返回 `Option<String>`：
  解析不到 node → `None` → `install_at` 回执 `Skipped("node not found")`。

---

## U3 — Qoder 的 `hooks` 在 `~/.qoder/settings.json` 生效吗？

**结论：生效。`~/.qoder/settings.json` 的 `hooks` 是官方支持面，且 Qoder 自带
`hooks migrate --from-claude` 子命令 —— 这直接证明了它与 Claude Code 的 hooks schema 同构。**

证据（`qodercli-1.1.68` 二进制内嵌 JS 源码片段）：

```
{srcPath: ge.join(r.userDir, "settings.json"), scope: "home", ...}   # userDir = ~/.qoder
```

```
Error saving migrated hooks: settings write failed
migrated hooks in ${W}/settings.json
function On(){return new X("migrate").description(`Migrate hooks from Claude Code to ${J}`)
  .option("--from-claude", "Migrate from Claude Code hooks", false) ...
```

迁移逻辑读取源文件（`.claude` 目录）：

```
let c = qe.join(i, "settings.local.json"), a = ... "settings.json"
...
"Error reading ${c}: ..." / "No Claude Code settings found in .claude directory.
Expected settings.json or settings.local.json"
let s = Cr(l);                              # Cr = 提取 hooks
if (Object.keys(s).length === 0) e.log("No hooks found in Claude Code settings to migrate.")
for (let [h, R] of Object.entries(s)) g.set(["hooks", ...])
```

**三重结论**：
1. 写入目标是 `~/.qoder/settings.json`（**不是**仅 `.qoder-plugin/qoder-hooks.json`）；
2. Qoder 官方把 Claude Code hooks **结构 1:1 迁移**过来（`g.set(["hooks", eventName, ...])`）——
   这是「三源共享同一 `HookEntry` 表」（AC2）的**最强证据**；
3. `.qoder-plugin/qoder-hooks.json` 是**插件**面的 hook 定义（`QODER_PLUGIN_ROOT` 变量只在
   插件 hooks 里可用），与 settings.json 面并存但语义不同 —— 我们走 settings.json 面。

---

## U4 — Claude `Notification` 事件的 matcher 语义

**结论：`matcher` 对 `Notification` **无效**（该事件无 matcher 概念）→ 按 R5.3 的降级规则
「不生效则删该行」，**从 `CLAUDE_COMPAT_ENTRIES` 中移除 `Notification` 映射**。**

证据（CodeBuddy 的类型定义，与 Claude Code 规范同源且注释显式说明；
`@tencent-ai/codebuddy-code/dist-server/types/node/hooks/hook-protocol.d.ts`）：

```ts
/**
 * Optional for events that don't require matching:
 * - UserPromptSubmit, Notification, Stop, SubagentStop: matcher is not used
 * - SessionStart: matches against 'source' field (startup|resume|clear|compact)
 * - SessionEnd: matches against 'reason' field (clear|logout|prompt_input_exit|other)
 * - PreCompact: matches against 'trigger' field (manual|auto)
 * - PreToolUse, PostToolUse: matches against tool_name
 */
matcher?: string;
```

本机 `~/.claude/settings.json` 的 `Notification` 条目实测 matcher 值为 **`""`**（空串），
与「不使用 matcher」一致（而非 `"permission_prompt"`）。

**影响**：
- 原 R5.3 草案的 `Notification` + `matcher: "permission_prompt"` → **无效**，
  若不删会导致**所有** Notification 事件（含 idle 提示）都映射为 `input_requested` = 误报。
- **决定**：删除该行。「等待输入」语义在 Claude 系由 `PermissionRequest` 覆盖
  （审批即需要用户行动），`Notification` 不映射。
- 修正后的映射表（四类语义仍需全覆盖 → 见下方「映射表定稿」）。

---

## 映射表定稿（回填 R5.3 / `CLAUDE_COMPAT_ENTRIES`）

| 原生事件 | matcher | event_key | 语义类 | 说明 |
|---|---|---|---|---|
| `PermissionRequest` | `*` | `approval_requested` | ActionRequired | 主路径：权限门 = 等待用户行动 |
| `Stop` | 无 | `turn_completed` | Completed | 主 agent 结束响应 |
| `StopFailure` | 无 | `session_failed` | Failed | Stop hook 自身失败（异常终止） |
| `SessionEnd` | 无 | — | — | 与 `Stop` 重复，**不映射**（避免双发） |
| `Notification` | — | — | — | **不映射**（U4：matcher 无效，映射会误报） |
| `SubagentStop` | 无 | — | — | 子 agent 结束，非「用户需要注意」 |

**`input_requested` 的归属**：Claude 系**无**独立的「等待输入」事件
（`Notification` 是唯一的候选且 matcher 不可用）。
决策：**`input_requested` 在 Claude 系不映射** —— 等待用户行动已由 `PermissionRequest`
（ActionRequired 类）覆盖，用户不会漏掉通知；宁缺勿误报（与 U4 的降级原则一致）。

> 这一条修正了 `prd.md` R5.1「四类语义全部覆盖」在 Claude 系的可行性假设。
> 四类覆盖仍是**任务级目标**（OMP 有 `tool_call`；Codex 有 `PermissionRequest`），
> 但**不是每个 CLI 都能覆盖四类** —— 这是数据事实，不是设计缺陷。

---

## 对 design.md 的修订项

1. `CLAUDE_COMPAT_ENTRIES`：3 行（`PermissionRequest` / `Stop` / `StopFailure`），
   **不含** `Notification`。
2. OMP：需要 pi 模板的**变体**（删 `ui_prompt_start` 段），不是「同一常量复用」——
   `prd.md` AC1 的措辞需从「同一常量」改为「pi 模板的派生素材（同源，差异仅事件订阅集）」。
3. `platform/hook_command.rs::render_report_command` 返回 `Option<String>`（node 缺失 → `None`）。
4. `hook_targets_are_unique` 断言修正（T10）确认为**必要**：OMP 变体模板文件名若与 pi 同名
   （`neeko-status.ts`，不同目录）会触发原断言。
