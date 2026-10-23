# PRD · Agents 配置单一数据源

## 背景

后端 `AgentManager` 已经是 agent 配置的**唯一真相**：`add_agent` 写覆盖层、`get_agent` 读当前生效值、`adapter_for` 用它 spawn。这一层是正确的。

问题在前端：为了「设置页改完立刻看到」，它又存了**两份本地快照**，加上后端的覆盖层，一共三处可写、三处可读。

| # | 位置 | 类型 | 谁读 | 谁写 |
| --- | --- | --- | --- | --- |
| 1 | 后端 `~/.neeko/config.json` 的 `agentOverrides` | `AgentConfig` 快照 | **spawn**（`adapter_for`）· `get_agent` / `list_agents` | `add_agent()` |
| 2 | 前端 `AppConfig.agentOverrides` | `Record<id, AgentConfig>` | **只有设置页**（`getEffectiveAgent`） | `saveBuiltinOverride` / `resetBuiltinOverride` |
| 3 | 前端 `AppConfig.agentCommandOverrides` | `Record<id, string>` | **终端**（`terminalCache.ts` / `TerminalView` / `TerminalViewBase`） | `saveAgentOverride`（双击命令行） |

### 实测确认的漂移（这是 bug，不是审美）

**① 设置页改启动命令，终端读不到**

```
设置页保存  →  后端 agentOverrides + 前端 config.agentOverrides   （更新）
终端起 TUI  →  getAgent() 之后再被 config.agentCommandOverrides 覆盖   （未更新）
```

`terminalCache.ts:273`：

```ts
const agent = await getAgent(agentId);          // 后端已是新值
const cmd = agentCommandOverrides?.[agent.id] ?? agent.command;   // 又被旧副本覆盖
```

`TerminalViewBase.tsx:254` 同样：

```ts
const cmd = cmdOverride ?? agent.command;       // cmdOverride 优先
```

用户改了设置、界面也显示改了，但终端行为不变。

**② 双击命令行编辑不落盘**

`useSettingsPanelState.ts` 的 `saveAgentOverride` 只调 `onConfigChange`（写前端 config），**完全不碰后端**。改完重启应用即丢失。

**③ 注释已承认字段该删但仍在用**

`settings.ts:102`：

```ts
/** 内置 agent 的 command 覆盖（旧字段，已由 `agentOverrides` 取代，保留兼容读取）。 */
agentCommandOverrides: Record<string, string>;
```

而它仍是终端的**唯一**来源 —— 注释与事实相反。

## 第一性原理

一个 agent 进程的启动配置只应存在**一份**。任何「为了响应快」而保存的第二份副本，都必须自己维护与真相的一致性；而一致性维护点一旦分散到多个消费方（设置页 / 终端 / Skill 页 / 项目设置），就必然有遗漏。

**正确形态**：

```
后端 AgentManager（唯一真相）
      ↓ get_agent / list_agents
前端 agentStore（一份缓存，只读）
      ↓
所有消费方读同一份
```

「改完立刻看到」由**写后刷新**保证，而不是靠前端另存一份。

## 需求

### R1 · 唯一的 agent 缓存

新增 `src/shared/store/agentStore.ts`：

```ts
interface AgentStore {
  /** 后端 `list_agents` 的快照；`null` = 尚未加载。 */
  agents: AgentConfig[] | null;
  /** 重新拉取（唯一刷新入口）。 */
  refresh: () => Promise<void>;
  /** 按 id 取（未加载时返回 undefined，不触发请求）。 */
  byId: (id: string) => AgentConfig | undefined;
}
```

- 数据只来自后端 `list_agents`，不来自任何前端覆盖层。
- `byId` 是同步的（消费点如终端不能 await）。
- 加载时机：应用启动一次 + 每次写操作后刷新。

### R2 · 写操作只有两个出口

`src/features/agent/api/agentApi.ts` 新增（或改造）两个函数，**内部落盘 + 刷新缓存**：

```ts
export async function saveAgent(agent: AgentConfig): Promise<void> {
  await invoke('add_agent', { agent });
  await useAgentStore.getState().refresh();
}

export async function resetAgent(agentId: string): Promise<void> {
  await invoke('remove_agent', { agentId });
  await useAgentStore.getState().refresh();
}
```

- 内置 agent 的覆盖保存、自定义 agent 的新建/编辑、`skill_path` 行内编辑、`enabled` 开关，全部走这两个函数。
- **禁止**任何调用方「先改前端 config 再 fire-and-forget 后端」。

### R3 · 删除两份前端副本

```ts
// src/shared/types/settings.ts
- agentOverrides?: Record<string, AgentConfig>;
- agentCommandOverrides: Record<string, string>;
```

连带删除：

| 文件 | 删除内容 |
| --- | --- |
| `useSettingsPanelState.ts` | `saveBuiltinOverride` / `resetBuiltinOverride` / `getEffectiveAgent` / `getEffectiveAgentCommand` / `startEditAgent` / `saveAgentOverride` |
| `BuiltInAgentsSection.tsx` | 双击命令行行内编辑（与表单重复，且是漂移源） |
| `TerminalView.tsx` / `TerminalViewBase.tsx` | `agentCommandOverride` prop 整条链 |
| `terminalCache.ts` / `terminalAgentSwitch.ts` | `agentCommandOverrides` 参数 |
| `useProjectActions.ts` | 传给 `switchAgentInTerminal` 的第三参 |
| `appConfigNormalize.ts` | 两个字段的默认值与归一化 |

### R4 · 内置 agent 仍完全可改

**这是明确要求，不是妥协**：内置定义的二进制参数不可能覆盖所有用法，用户必须能改 `command` / `args` / `chat`。

- 内置 agent 的 `Pencil` → 打开完整 `AgentForm`（现状保留）。
- 保存 → `saveAgent()` → 后端覆盖层 + refresh。
- `Reset` → `resetAgent()` → 清覆盖 + refresh。
- 与自定义 agent 的唯一差别是「Reset 可回到出厂」和 `is_builtin` 身份。

### R5 · 顺带修两个已确认的缺陷

**① `List Models Args` 与会话内模型能力互斥**

spec `agent-chat-transports.md` §10.5b 记录的实测事故：声明了 `ConfigCapability::SessionConfig` 的传输（ACP / PiRpc）**不得**再填 `model_list_args` —— CLI 表格给 `provider/model` 复合串，而写回要裸名，会得到 `Model not found: provider/provider/model`。

表单当前把两个字段并排摆着，用户完全可能都填。**判据**：`transportOf(chat) ∈ {acp, pi-rpc}` 时隐藏该输入框，并给一行说明。

**② `Detection::Directory` 静默降级**

后端支持 `Command { target }` / `Directory { target }`，前端只能产出 `command`（`agentFormState.ts` 里 `type === 'command' ? target : ''`，反向恒构造成 `command`）。加载一个用 `directory` 检测的 agent 再保存，**类型被静默改成 `command`**。

修法：表单态保留 `detectionType`，往返不丢。

## 非目标

- 不改 `AgentManager` / `add_agent` / `remove_agent` 的后端行为（它们已经正确）。
- 不改 `AgentForm` 的区块划分与视觉（本轮只修 R5 的两个 bug）。
- 不改「内置 vs 自定义」的可编辑性差异。
- 不引入 agent 配置的增量 patch（`add_agent` 仍收整份 `AgentConfig`）。

## 验收标准

1. `grep -rn "agentCommandOverrides" src/` 无结果。
2. `grep -rn "agentOverrides" src/` 无结果（`config.json` 的后端字段名除外，它在 `src-tauri/`）。
3. 终端启动 agent 与切换 agent 时，命令**只**来自 `agentStore.byId(id)`（源码护栏断言无其他来源）。
4. 设置页保存内置 agent 后，`agentStore` 立即反映新值（测试：mock `list_agents` 返回更新后的值，断言 store 更新）。
5. 双击命令行行内编辑已删除；`saveAgentOverride` / `getEffectiveAgent` / `getEffectiveAgentCommand` / `saveBuiltinOverride` / `resetBuiltinOverride` 均无残留。
6. `List Models Args`：`transportOf` 为 `acp` / `pi-rpc` 时不渲染该输入框（渲染测试断言 DOM）。
7. `Detection`：`directory` 类型经表单往返后仍为 `directory`（纯函数测试）。
8. `pnpm check:quick` 全绿；`cargo test` 全绿。
9. 每个新护栏做变异验证（改回旧行为必须变红）。
