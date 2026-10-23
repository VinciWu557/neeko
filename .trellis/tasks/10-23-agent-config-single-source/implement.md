# Implement · Agents 配置单一数据源

> 顺序不可调换：Step 1 落地后每一步都可独立验证、独立回滚。
> 每步结束 `pnpm check:quick` 全绿再进下一步。

---

## Step 1 · `agentStore` + 写出口（旧路径不动）

**目标**：建立唯一缓存与唯一写入口，此时旧的 `agentOverrides` / `agentCommandOverrides` 仍在用，行为零变更。

- [x] 1.1 **先写测试**（Red）：`src/shared/store/__tests__/agentStore.test.ts`
  - `agents` 初值为 `null`（不是空数组 —— 区分「未加载」与「确实没有」）
  - `refresh()` 调 `listAgents()` 并替换快照
  - `refresh()` 失败时不把 `agents` 置空（保留上次成功的快照）
  - `byId` 命中返回对象、未命中返回 `undefined`、未加载也返回 `undefined`（不触发请求）
  - `setAgents` 直接替换（测试夹具）
- [x] 1.2 实现 `src/shared/store/agentStore.ts`（zustand，照 `gitStore.ts` 的形态）。
- [x] 1.3 **先写测试**（Red）：`src/features/agent/api/__tests__/agentApi.save.test.ts`
  - `saveAgent` 先 `invoke('add_agent')` 再 `refresh()`（断言调用顺序）
  - `saveAgent` 保留 `is_builtin: true`（内置覆盖不丢身份）
  - `resetAgent` 先 `invoke('remove_agent')` 再 `refresh()`
  - `invoke` 失败时不 `refresh`（不制造「以为保存成功」的假象）
- [x] 1.4 实现 `saveAgent` / `resetAgent`（`src/features/agent/api/agentApi.ts`）。
- [x] 1.5 在 `useAppConfig` 的 load effect 末尾加 `void useAgentStore.getState().refresh();`（不 await，不阻塞配置加载）。
- [x] 1.6 变异验证：`saveAgent` 里去掉 `refresh()` → 1.3 的用例红；`byId` 未加载时返回 `{}` 而不是 `undefined` → 1.1 用例红。

**验收**：`pnpm check:quick` 全绿；`grep -rn "agentCommandOverrides" src/` 计数**未变**（本步不动旧路径）。

---

## Step 2 · 消费点改读 store

**目标**：终端与设置页都读同一份快照。

- [x] 2.1 **先写测试**（Red）：`src/features/terminal/components/__tests__/terminalAgentCommandSource.test.ts`
  - 源码护栏：`terminalCache.ts` / `TerminalViewBase.tsx` 里**不存在** `agentCommandOverrides`
  - 终端取 agent 命令的唯一来源是 `useAgentStore`（断言文件包含 `useAgentStore`）
- [x] 2.2 `terminalCache.ts`：`switchAgentInSessionTerminal` 去掉 `agentCommandOverrides` 参数，改 `useAgentStore.getState().byId(agentId)`；未命中则 `return`（不猜命令）。
- [x] 2.3 `TerminalViewBase.tsx`：删除 `agentCommandOverride` prop 与 `cmdOverride ?? agent.command` 分支；改为 `useAgentStore.getState().byId(tabAgentId)`，未命中不启动并 `console.warn`。
- [x] 2.4 `TerminalView.tsx`：删除 `config.agentCommandOverrides?.[tabAgentId]` 读取与透传。
- [x] 2.5 `terminalAgentSwitch.ts` / `useProjectActions.ts`：删除第三参。
- [x] 2.6 `SettingsView.tsx` / `SettingsPanel.tsx` / `ProjectPanel.tsx` / `LocalSkillContent.tsx` / `ProjectSkillContent.tsx`：`listAgents()` 改为 `useAgentStore(s => s.agents)`，需要刷新时调 `refresh()`。
- [x] 2.7 **先写测试**（Red）：设置页渲染测试 —— store 有 agent 时列表可见；store 为 `null` 时不渲染空态文案（与「确实为空」区分）。
- [x] 2.8 变异验证：把 `terminalCache` 改回 `getAgent()` 异步取 → 2.1 护栏红；把 `TerminalViewBase` 的 `byId` 改成 `agents?.find` 忽略 null → 2.7 用例红。

**验收**：终端起 agent / 切 agent 的命令只来自 store；设置页与终端看到同一份数据。

---

## Step 3 · 删除两份前端副本

**目标**：`agentOverrides` / `agentCommandOverrides` 从代码中彻底消失。

- [x] 3.1 `src/shared/types/settings.ts`：删除 `agentOverrides?` 与 `agentCommandOverrides` 两个字段。
- [x] 3.2 `useSettingsPanelState.ts`：删除 `saveBuiltinOverride` / `resetBuiltinOverride` / `getEffectiveAgent` / `getEffectiveAgentCommand` / `startEditAgent` / `saveAgentOverride` / `editingPresetId` / `editingValue` 及其 state 与返回项。
- [x] 3.3 `BuiltInAgentsSection.tsx`：删除双击命令行行内编辑（`isEditing` / `editingValue` / `onStartEditAgent` / `onSaveAgentOverride` 相关全部）与 `getEffectiveAgentCommand`；`getEffectiveAgent` 改为读 store。
- [x] 3.4 `handleReset` 改为直接 `await resetAgent(agent.id)`（不再手动删两个 Record）。
- [x] 3.5 `AgentForm` 的 `onSaved` 回调改为 `saveAgent(agent)`；`skill_path` 行内编辑同样走 `saveAgent`。
- [x] 3.6 `appConfigNormalize.ts`：删除两字段的默认值与归一化分支（保留「未建模键原样带过」契约本身）。
- [x] 3.7 `SettingsView.tsx` / `SettingsPanel.tsx` / `AgentsPanel.tsx`：清理随 props 链传递的已删字段。
- [x] 3.8 **先写测试**（Red）：源码护栏 `src/features/settings/components/__tests__/noAgentOverrideCopies.test.ts`
  - `src/` 下（排除 `src-tauri/`）不存在 `agentCommandOverrides` / `agentOverrides` 字符串
  - 不存在 `saveAgentOverride` / `getEffectiveAgentCommand` / `saveBuiltinOverride` / `resetBuiltinOverride` 标识符
- [x] 3.9 变异验证：把 `agentCommandOverrides` 加回 `settings.ts` → 3.8 护栏红。

**验收**：`grep -rn "agentCommandOverrides\|agentOverrides" src/` 无结果；`pnpm check:quick` 全绿。

---

## Step 4 · 修两个已确认的缺陷

- [x] 4.1 **先写测试**（Red）：`AgentForm` 渲染 —— `chatTransport === 'acp'` 时**不**渲染 `List Models Args` 输入框（`queryByLabelText` 为 null），且出现说明文案；`chatTransport === 'serve'` 时**渲染**该输入框。
- [x] 4.2 `AgentForm.tsx`：按 design §2.6 加 `sessionScoped` 门控。
- [x] 4.3 **先写测试**（Red）：`agentFormState` 纯函数 —— `detection: { type: 'directory', target: 'x' }` 经 `toTextState` → 构建回 `AgentConfig` 后仍为 `directory`。
- [x] 4.4 `agentFormState.ts` 加 `detectionType` / `detectionTarget`；`AgentForm` 的 `buildConfig` 按 design §2.7 组装；UI 加 `type` 选择（select，两项）。
- [x] 4.5 变异验证：把 4.2 的门控改成恒 `false`（永远显示）→ 4.1 红；把 `detectionType` 硬编码成 `'command'` → 4.3 红。

**验收**：两个 bug 各有渲染/纯函数测试；变异确认变红后还原。

---

## Step 5 · 收尾

- [x] 5.1 `pnpm check:quick`（18 护栏 + lint_fe + lint_rust）。
- [x] 5.2 `cargo test`（后端不受影响，确认无回归）。
- [x] 5.3 更新 `.trellis/spec/frontend/` 相关文档：新增「agent 配置单一数据源」契约（store 唯一缓存 + `saveAgent`/`resetAgent` 唯一写入口 + 禁止前端副本）。
- [x] 5.4 在 `agent-chat-transports.md` 的 §10.5d 补一句：`agentOverrides` 的前端副本已删除，现在只有后端一份。
- [x] 5.5 汇总变更清单交给用户，**不主动提交**。

---

## 验证命令

```bash
pnpm check:quick
cargo test --manifest-path src-tauri/Cargo.toml
npx vitest run
```

## 回滚点

| 回滚到 | 影响 |
| --- | --- |
| Step 1 后 | store 与写出口就位但未启用，旧路径完好 |
| Step 2 后 | 读路径已统一，副本仍在写（但无人读）—— 可安全回退 |
| Step 3 后 | 副本已删，必须整体回退本步 |

---

## Step 6 · P3 收尾（不留尾巴）

- [x] 6.1 `app/` 不再深层 import `features/settings/hooks/useAgentPreload` —— 走 `@/features/settings` 门面。
- [x] 6.2 跨域源码护栏落位 `tools/guards/checks/check_agent_config_single_source.py`（三条判据），
      配套单测 11 条；删除组件 `__tests__` 里重复的源码扫描（2 个文件）。
- [x] 6.3 `test_gates` 的进程内护栏计数基线 26 → 27（两条断言 + 注释）。
- [x] 6.4 三条判据做真实仓库变异验证（终端直查快照 / 组件直写 `invoke` / 副本标识符）。
- [x] 6.5 更新 spec：`state-management.md` 记录三条不变量 + 护栏判据。

> **未纳入本任务的 P3**：`shared/*` 对 `features/*` 的 13 处反向依赖。
> 它们全部带 `eslint-disable` + 理由，属既有架构债（`useKeyboardShortcuts` 的终端
> 仲裁、`taskStore` 的 task/lsp API 等）。动它要重划 shared 与 features 的边界，
> 是独立任务 —— 与本任务的「agent 配置单源」无因果关系。
