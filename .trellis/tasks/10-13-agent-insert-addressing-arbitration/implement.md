# 执行计划：Agent 投递接通 + 前台仲裁归一

> 任务：`.trellis/tasks/10-13-agent-insert-addressing-arbitration`（PRD `prd.md` · 设计 `design.md`）
> 顺序原则：**先立新接收端（可独立验）→ 切派发方 → 归一仲裁 → 收签名与死导出 → 护栏 → 全量**。
> 每批独立可回滚；改动停在未提交状态（是否提交由开发者决定）。
>
> **⚠️ 批次 1 的前置条件：Q5 必须已定案**（投递机制 = 注册表 A / 保留事件 B）。
> 本计划按 **Q5=A（design 推荐）** 书写；若选 B，批 1/批 2 的落点文件与验收形态需重写（见批 1 末「B 路径差异」）。

---

## 批 0 · 清账前置：日志与文档的既存错位（小、独立、可先合）

**动作**
1. `terminalCache.ts:73,100` 两处 `log(\`Cache destroyed for ${key}\`)` → `terminalKeyLabel(key)`
   （design §8 第 4 条；R3 风险「裸键进日志」的既存违例）。
2. `terminalCommands.ts:27,79` 把 `session.key` 喂给 `terminalKeyLabel` → 恒返回
   `<invalid terminal key>`，身份信息全丢 → 改 `workspaceKeyLabel(session.key)`。
   （这条是 10-12 R6「两个命名空间」的漏网调用，非风格问题。）
3. `10-12` 的 `design.md` §7 风险表追加一行：分屏 p2+ 写侧携带 paneId / 读侧缺省 p1
   → **后果与处置指向本任务 design §4**（Q6 三处落地的第 3 处）。
4. `src/AGENTS.md` 红线 12 段补一行：指向 `check_terminal_key_mint` +
   `docs/domain-model.md` 的 terminal 小节（10-12 审查 S8：该护栏在 AGENTS.md 可达性为零）。

**验证**：`pnpm lint`；`grep -n "terminalKeyLabel(session.key)" src -r` 归零；
`npx vitest run src/features/terminal` 不回归（基线 11 files / 95 tests，实测已过）。

---

## 批 1 · 立新：agent 输入注册表（`agent-chat/api/agentInputRegistry.ts`）

**动作**（照抄 `editor/api/aiActionRegistry.ts` 的同构形态：Map + 引用计数 + 未命中 false）
1. `identityOf(session, tabId)` —— 身份基底是 `session.key`（红线 12，不从字符串反解）。
2. `registerAgentInput` / `unregisterAgentInput` / `insertAgentInput(session, tabId, text): boolean`
   （签名细节见 design §2）。
3. `AgentChatTabView`（或 `ChatComposer` 挂载层）在 `useEffect` 登记、卸载注销；
   handler = 把文本并入 `setInput`（受控 textarea 的**正确**写入路径是调 `setInput`，
   **不是**写 `el.value`；`useImeSpaceGuard` 那种 `value=`+`InputEvent` 手法是给非受控/原生场景的，
   这里有 `setInput` 可用，别仿）。
4. 单测（**Red 先行**，`src/features/agent-chat/api/__tests__/agentInputRegistry.test.ts`）：
   - 未登记 → `insertAgentInput` 返回 **false**；
   - 两个 agent-chat tab 并存（主仓 session vs worktree session）→ 只精确命中目标；
   - **StrictMode 双挂载**：同身份 register×2 后 unregister×1，仍能投递（引用计数，design T2）；
   - 同 session 多 composer、`tabId=null` → 走 **order 升序**首个（不许自带 sort，复用批 2 的仲裁）。

**B 路径差异（若 Q5=B）**：本批改名为「载荷扩 `{session, tabId, text, handled}` + 新增监听 hook」，
且需在设计里追加一条**无法机器校验**的纪律（所有监听者同步处理）与对应风险行。

**验证**：新单测先 Red 后绿（Red 的证据要留在批记录里——它是本任务 defect 的原始反证）；`pnpm lint`。

---

## 批 2 · 归一仲裁（design §2 的 R1 面）

**动作**
1. `terminalRouting.ts`：新增 `foregroundAgentCliTab(session)` = 在 `foregroundTerminalTab` 的
   有序序列上过滤 `agentId !== null`（**不再 sort**）；新增 `insertToSessionAgent(session, text)`
   = composer 优先 → Agent CLI 降级 → `{ok:false}`（Q1）。
2. `terminalCache.ts`：`firstTerminalKeyOfSession` / `firstTerminalEntryOfSession`
   去掉 `export`（降为模块私有，design §2）。
3. 消费侧口径删除（每处都要 grep 确认「不再自带 order/find」）：
   - `pickerUtils.findAgentCliTab` → 委托 `foregroundAgentCliTab`（Q2：升序）
   - `useEditorAgentActions.findAgentTab` → 同上（#4）
   - `PromptsStatusSection.revealTerminalTab` → 用 `insertToSessionTerminal` 返回的落点 tabId
     直接 `activateTab`（删自建 session 拼装，#5）
   - `useTerminalTabs.getActiveTab` / `getActiveTabId` → **删除**（#6，实测零消费者）
4. 单测：`terminalRouting.test.ts` 补 `foregroundAgentCliTab` 的用例（含「与 terminal 仲裁同序」断言
   —— 这条是 Q2 的可执行形式）；`useTerminalTabs.test.ts` 随删除项清理。

**验证**：`npx vitest run src/features/terminal src/features/browser src/features/editor`；
`grep -rn "firstTerminalKeyOfSession\|firstTerminalEntryOfSession" src | grep -v terminalCache.ts` 归零；
`grep -rn "b.order - a.order" src` 归零（反向口径消失）。

---

## 批 3 · 切派发方 + 收签名 + 死导出（症状消除批）

**动作**
1. `TerminalInsertContext.tsx`：`insertToAgentInput(text)` → `(session, tabId, text): boolean`；
   删除注释「best-effort 事件桥接，无返回值」（它对现状的描述是假的）。
2. `ProjectView.tsx:186` 与 `:220`：派发点改调 `insertToSessionAgent`（session 仍来自
   `activeWorkspaceSession(activeProject.id)`，红线 12）。
3. `useInsertPromptToWorkspace.ts:29-34`：降级链重新可达 —— `insertToAgentInput` 返回 false
   → clipboard + toast（**这条测试在批 1 之前必须先失败**，R6）。
4. `useFileDrop.ts:44-64`：**删 `isTextInputElement` 及其两条判据分支**，改为
   Priority 1 = `insertToSessionAgent` / Priority 2 = `insertToSessionTerminal`（design §1.1
   连带 defect：终端聚焦时旧判据恒 true，Priority 2 永不执行）。
   同步改写 `useFileDrop.test.ts` 的两条 Priority-1 测试 —— 它们断言「派发了事件」，
   **而那本身就是缺陷的一部分，不是保护网**（design §5.4）。
5. `sendToTerminal` / `refreshTerminalForSession` / `switchAgentInSessionTerminal` 的
   `tabId` 改必填（R3）；`useAgentActions.ts:79` 改为先 `foregroundTerminalTab` 再刷新；
   `useKeyboardShortcuts.ts:160` 的 store 顶层 `activeTabId` 改为仲裁结果（design §1.3）。
6. 删 `pasteToTerminal`（Q7）+ 两个桶文件条目 + `pasteToTerminal.test.ts` 迁移到
   `pasteToTerminalSession` 的用例。
7. Q5=A 时：删 `INSERT_TO_AGENT_INPUT_EVENT`（`shared/events.ts:59` 及其注释）；
   验收 grep 归零。

**验证**：`pnpm lint`（TS 签名即编译期清单，design R7 红利）；
`grep -rn "isTextInputElement" src` 归零；`grep -rn "INSERT_TO_AGENT_INPUT_EVENT" src` 归零（Q5=A）；
`grep -rn "pasteToTerminal(" src` 归零；`npx vitest run src` 相关面全绿。

---

## 批 4 · 护栏（R1/R6 的可执行性 + 10-12 R6 遗留）

**动作**（判据全文见 design §3；台账形态照抄 `path_identity_scope.json`）
1. 新护栏 `tools/guards/checks/check_terminal_foreground_arbitration.py`
   （A1 口径唯一 / A2 第二口径退出 / A3 tabId 必填不回退）
   + 台账 `tools/guards/ledger/terminal_foreground_arbitration.json`
   + **强制**同名测试 `tools/guards/tests/test_check_terminal_foreground_arbitration.py`
   （`registry.py::_validate`：缺同名测试 = RegistryError，不是「违规」）。
2. 扩 `check_terminal_key_mint` 加 **G3**：`TERMINAL_KEY_SEP` / `\u0001` 在 `terminalCache.ts`
   外零命中（当前基线：仅 `terminalAddress.test.ts`，测试豁免后为 0）；
   并在 docstring 写明 G1 对 `MINT_FILE` 整文件放行的边界与代价（10-12 审查 S6）。
   同步扩 `test_check_terminal_key_mint.py`（G3 正/负例 + 测试豁免 + 扫描集为空判 ERROR）。
3. `GUARD.docs` 指向的文档**必须存在**（`registry.py` 机器校验）：先落
   `docs/domain-model.md` 的 agent 投递小节，再挂 docs 指针。

**验证**：故意新增一处 `sort((a,b)=>b.order-a.order)` 于 browser 域 → 确认被拦 → 删除（Red 证据）；
`pnpm guards list` 含新护栏；`pnpm lint` 全绿。

---

## 批 5 · 全量验证 + 收尾

- `pnpm check` 全绿；`npx vitest run src/features/terminal` 保持 95 tests 不回归；
- 逐条勾 PRD AC（含「拖文件到终端不再静默」「Q6 三处文档落地」两条）；
- 端到端手测（需 `pnpm tauri dev`，无 GUI 则显式记为未执行）：
  prompts 面板 Enter → 落当前 workspace 的 composer；无 agent-chat tab → clipboard + toast；
  拖文件到聚焦的终端 → 文本进该终端；主仓 + worktree 两个 composer 并存不串；
- spec 沉淀：`interaction-patterns.md` §「拖拽到输入」的架构图与 4 条设计要点**必须重写**
  （它现在描述的是本次判定为 defect 的 `isTextInputElement` 双目标分发，见该文件 422-441 行）；
- `add_session.py` 记录；`task.json` 状态更新；归档另起 commit。

---

## 命令速查

```bash
# 批 1 Red 证据（当前 defect 的显式反证）
npx vitest run src/features/library/hooks/__tests__/useInsertPromptToWorkspace.test.ts
# 批 2 口径归零
grep -rn "firstTerminalKeyOfSession\|firstTerminalEntryOfSession" src | grep -v terminalCache.ts
grep -rn "b.order - a.order" src
# 批 3 死符号 / 死事件归零
grep -rn "isTextInputElement\|INSERT_TO_AGENT_INPUT_EVENT\|pasteToTerminal(" src --include="*.ts*"
# 批 4 护栏单测
python3 -m unittest discover -s tools/guards/tests -t tools -p "test_check_terminal_foreground_arbitration.py"
python3 -m unittest discover -s tools/guards/tests -t tools -p "test_check_terminal_key_mint.py"
# 全量门禁（批末）
pnpm check && npx vitest run src/features/terminal
```

## 边界复述

- 不修分屏 p2+（Q6：非目标，design §4）；不动 `agent-chat` 会话协议 / adapter（08-17 范围）；
- 不收敛 `useEditorAgentActions.pending`（Q4：只记账，design §8）；
- 不把 tabId/paneId 并入 `WorkspaceSession`（10-12 Q2 决议仍有效）；
- 顺序口径全仓只允许 `foregroundTerminalTab` 内那一次 `sort`（Q2）；
- 投递形态只允许一种，禁止「事件 + 注册表」双轨（design §5.2）；
- 不新增红线（映射红线 5 + 12）；改动停在未提交状态。
