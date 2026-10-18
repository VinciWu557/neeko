# Implement — DSH 完整 TUI

> 根因与可行性见 `prd.md`，落点与取舍见 `design.md`。
> TDD 强制；**实施顺序不可交换**（design §10），但真机验证**集中在 Step 9 统一做**
> （开发完成后一次实跑全部 AC）—— 开发循环（Step 1–8、10）只跑 `prepublishOnly`，
> 不逐步起 CLI。Step 10（收尾）在真机验证**之后**做，只含非实机项。

---

## Step 1：依赖 + `--tui` flag（不动行为）

- [x] `package.json` 加 `@earendil-works/pi-tui: ^1.3.0`（dependencies）→ `pnpm install`。
- [x] 对照 npm 1.3.0 与参考实现的五处 rendering fix：逐条列出行为差异 → 记入本文件末尾「pi-tui 差异清单」（有差异再决定 patchedDependencies）。
- [x] Red：`resolveStartupValues({ tui: true })` → `tui: true`；未给 → 键不出现
      （照抄 spawn 三态测试形态；`StartupFlags` 加 `tui?: boolean`）。
- [x] Green：`startup.ts` 加 `.option('--tui', ...)`；`NeekoStartupValues` 加 `tui?: boolean`。
- [x] Green：`cordis.patch.yml` 加 `neeko-tui` 行（先试 `when:` 条件语法；
      patch 不支持 → 双 runner 挂载 + apply 内分流，见 design §1 保底）。
- [x] `prepublishOnly` 全绿（含既有桥测试无回归）。

## Step 2：runner 骨架（无 UI 冒烟）

- [x] Red：runner 的 resume-失败回落 create 的分支逻辑（纯函数化后单测）。
- [x] Green：`src/tui/runner.ts`：`apply(ctx, config)` —— `config.tui` 分流、
      `agents.create/resume`（照抄桥的 `doActivate` 接线）、`whenIdle()`、
      顶层 catch → stderr + `appExit(1)`。
- [x] Green：`index.ts` 导出 `name: 'dsh-neeko/tui'` 的第二个插件入口（或按 patch 语法组织）。
- [x] `prepublishOnly` 全绿。

## Step 3：最小屏幕（首个人工可视点）

- [x] Green：`src/tui/app.ts` —— `TuiMainScreen` + header + Editor + footer 装配；
      `tui.setFocus(editor)`；Editor.onSubmit → stderr 日志（此时还不接 agent）。
- [x] Red/Green：app 键位路由的单测骨架（`isKeyRelease` 忽略 / Editor 焦点分派），
      用伪组件（照桥的 `capturingSource` 模式）。
- [x] `prepublishOnly` 全绿。

## Step 4：会话恢复历史（AC6 先行）

- [x] Red：`transcript.feedEvent` 折叠测试 —— tool/call+result 配对、orphan 丢弃
      （从桥的 dsh-adapter 测试移植语义，但数据结构换转录行）。
- [x] Red：`buildHistoryFromLog`（runner 侧）：`readSessionEvents` + 桥的 `buildHistory`
      → 转录行；**attach 时间线**判据（design §4）的边界测试。
- [x] Green：`src/tui/transcript.ts` + runner 里历史填充（`whenIdle()` 后一次性渲染）。
- [ ] **真机（留到 Step 9）**：`--session <旧id>` 恢复 → 历史完整呈现
      （找一个既有会话 id：`dsh sessions list` 或从桥的 session.init 里取）。
- [x] `prepublishOnly` 全绿。

## Step 5：流式渲染（AC2 核心）

- [x] Red：delta 累积测试 —— `text-delta`/`reasoning-delta` 追加到正确气泡；
      attempt 重试（新 `attemptId`）产生新气泡不混流（复用桥的 id 纪律）。
- [x] Red：**防双发** —— `assistant/message` 事件在 attach 时间线之后到达 → 不产生转录行
      （变异验证：改成从历史重发 → 必红）。
- [x] Red：50ms 合帧测试（伪时钟，断言合帧后单次 render 请求）。
- [x] Green：`transcript` 接 `agent/assistant-stream` 帧 + `session/event` 工具行；
      app 里挂 working indicator（`agent/status`）。
- [ ] **真机（留到 Step 9）**：真实提问 → 文本增量出现（非整段）、思考/正文分离、
      working 态正确。
- [x] `prepublishOnly` 全绿。

## Step 6：工具呈现（AC3）

- [x] Red：工具行渲染测试 —— 调用/结果成对、失败态标记、参数/结果文本截断策略。
- [x] Green：`src/tui/present.ts`（参考实现 present.ts 218 行 + diff.ts 50 行的精简版）。
- [ ] **真机（留到 Step 9）**：触发工具的 prompt → 调用与结果成对、失败可见。
- [x] `prepublishOnly` 全绿。

## Step 7：审批 / 提问（AC4 / AC5）

- [x] Red：审批状态机 —— 触发行内 UI / 允许 → resolve('allowed-once') /
      拒绝 → resolve('rejected') / ESC 或 signal abort → 'cancelled'。
- [x] Red：提问状态机 —— options 题 SelectList / 自由输入题 / 多题顺序 /
      abort → ASK_ABORTED / 返回形状逐字段断言（照桥的 answer 形状测试）。
- [x] Green：`src/tui/interactions.ts`；复用桥的 `canAnswerQuestions` 谓词与
      waiter 生命周期模式（Map + abort listener + cancelAll）。
- [ ] **真机（留到 Step 9，AC4）**：审批两条路径。
- [ ] **真机（留到 Step 9，AC5）**：行内问答回传。
- [x] `prepublishOnly` 全绿。

## Step 8：斜杠命令

- [x] Green：`src/tui/commands.ts` —— `/help` `/clear` `/model`（只读）`/exit`，
      接 `CombinedAutocompleteProvider`。
- [x] Red：命令路由单测（未知命令不崩 / `/exit` 触发退出回调）。
- [x] `prepublishOnly` 全绿。

## Step 9：统一真机验证（AC1–AC7 一次过）

> 开发完成后集中实跑。任何一项不过 → 修 → 重跑**该组**，不需重跑全部。

- [ ] **AC1 入口**：`--tui` 进 TUI（清屏、可输入、退出干净）；无 `--tui` 桥照常（health 200）。
- [ ] **AC2 流式**：真实提问 → 增量渲染、思考/正文分离。
- [ ] **AC3 工具**：调用/结果成对、失败态可见。
- [ ] **AC4 审批**：允许与拒绝两条路径都生效。
- [ ] **AC5 提问**：行内问答、答案回传后 agent 继续。
- [ ] **AC6 会话**：`--session <id>` 历史完整、可续聊。
- [ ] **AC7 桥零回归**：桥三件套（`--no-spawn` + health + WS handshake → session.init）。
- [ ] 发现的问题记入下方「真机发现」小节，修完复验。

### 真机发现

（待填）

## Step 10：收尾（开发内，无真机）

- [x] **契约自查（AC9）**：`grep -rn "session.events\|registerProvider\|assistant/chunk" src/tui/`
      → 零命中（注释里讲历史的除外）。
- [x] **既有测试**：`pnpm test` 全绿（含桥的 68 条，AC4 无回归的自动化面）。
- [x] `pnpm run prepublishOnly` 全绿（AC8）。
- [ ] spec 沉淀：TUI 适配层的双来源不变量（与桥同款）→ 是否入 `agent-hooks-domain.md`
      或新文档，收尾时判断。
- [x] 无副产物检查（`pnpm-lock.yaml` 不出现在 git status）。

---

## 验证命令速查

```bash
cd packages/dsh-neeko
pnpm run prepublishOnly        # check && test && build && lint:package

# 真机统一验证（Step 9）
dsh --profile neeko --tui --no-spawn --port 3197
dsh --profile neeko --no-spawn --port 3197        # 桥回归路径
curl -s http://127.0.0.1:3197/neeko-health

# 会话 id 来源（Step 4 用）
# 桥的 session.init 或 dsh sessions list
```

## 回滚点

| 回滚点 | 触发 | 动作 |
| --- | --- | --- |
| Step 1 后 | patch `when:` 语法不存在 | 转 design §1 保底方案（双 runner + config 分流） |
| Step 2 后 | agents 接线在 TUI 形态下行为异常 | 对照桥（已验证）逐行 diff 接线参数 |
| Step 3 后 | pi-tui 1.3.0 渲染异常 | 对照差异清单；必要时 patchedDependencies 或锁低版本 |
| Step 5 后 | 流式卡顿 | 50ms 合帧已有；仍卡则提前做 transcript 窗口化（原 R3 范围） |
| Step 7 后 | 审批/提问 waterfall 在 TUI 下不触发 | 先查 `setup` 注册时序（对照桥），再查 `inject` |
| 任意 | 发现必须动 `src-tauri/**` / `src/**` | **停止** —— 超出本任务边界，回用户 |
