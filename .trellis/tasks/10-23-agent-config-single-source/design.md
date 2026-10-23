# Design · Agents 配置单一数据源

## 1. 第一性原理

一个 agent 进程的启动配置只应存在**一份**。

任何「为了响应快」而保存的第二份副本，都必须自己维护与真相的一致性。而一致性维护点一旦分散到多个消费方（设置页 / 终端 / Skill 页 / 项目设置），就必然有遗漏 —— 因为每新增一个消费方，都要记得同步每一份副本。

实测已经产生三处漂移（见 PRD 背景）。**根因不是「哪个同步点漏了」，而是「存在需要同步的东西」。**

```
现在（3 份可写、3 份可读）
  后端 agentOverrides ──── spawn / get_agent
  前端 agentOverrides ──── 设置页
  前端 agentCommandOverrides ──── 终端

目标（1 份可写、1 份可读）
  后端 AgentManager（唯一真相）
        ↓ list_agents
  前端 agentStore（缓存，只读）
        ↓
  所有消费方
```

**「改完立刻看到」不靠第二份副本，靠写后刷新。**

## 2. 核心契约

### 2.1 `agentStore`

```ts
// src/shared/store/agentStore.ts
import { create } from 'zustand';
import type { AgentConfig } from '@/shared/types';
import { listAgents } from '@/features/agent/api/agentApi';

interface AgentStoreState {
  /** 后端 `list_agents` 的快照。`null` = 尚未加载（区别于「加载了但为空」）。 */
  agents: AgentConfig[] | null;
  /** 重新拉取。**唯一**刷新入口。 */
  refresh: () => Promise<void>;
  /** 按 id 取；未加载时返回 `undefined`（不触发请求）。 */
  byId: (id: string) => AgentConfig | undefined;
  /** 测试用：直接替换（不请求后端）。 */
  setAgents: (agents: AgentConfig[]) => void;
}
```

**为什么 `agents: AgentConfig[] | null` 而不是空数组作初值**：`null` = 「还没加载完」，空数组 = 「后端确实没有 agent」。两者混用会让首次渲染闪一下「无 agent」。与 spec §10.4 的三态原则同源。

**为什么 `byId` 是同步的**：终端 `TerminalViewBase` / `terminalCache` 在 PTY 就绪回调里取 agent 命令，那里不能 await（会打断已有的 setTimeout 编排）。store 快照保证同步可取。

### 2.2 加载时机

| 时机 | 位置 | 理由 |
| --- | --- | --- |
| 应用启动 | `useAppConfig` 的 load effect 之后（`refresh()`） | 与 `load_config` 同一批启动 I/O，不额外引入生命周期 |
| 每次写操作后 | `saveAgent` / `resetAgent` 内部 | 唯一刷新点，调用方不需要记得 |
| 设置页打开 | **不再单独加载** | 它读 store |

`useAppConfig` 里加一行 `void useAgentStore.getState().refresh();`（不 await，不阻塞配置加载）。

### 2.3 写路径

```ts
// src/features/agent/api/agentApi.ts

/** 保存 agent（内置走覆盖层，自定义走 customAgents）—— 落盘 + 刷新缓存。 */
export async function saveAgent(agent: AgentConfig): Promise<void> {
  await invoke('add_agent', { agent });
  await useAgentStore.getState().refresh();
}

/** 重置内置 agent 为出厂值（清除覆盖）—— 落盘 + 刷新缓存。 */
export async function resetAgent(agentId: string): Promise<void> {
  await invoke('remove_agent', { agentId });
  await useAgentStore.getState().refresh();
}
```

**为什么 API 层负责 refresh 而不是调用方**：调用方有 5 个（内置表单、自定义表单、skill_path 行内、enabled 开关、Reset）。让每个都记得 refresh 就是重演「同步点分散」的原始错误。

**为什么 `saveAgent` 不更新 `AppConfig.agentOverrides`**：那个字段本轮删除。后端 `add_agent` 已经把它写进 `~/.neeko/config.json`。

### 2.4 删除清单

| 文件 | 删除内容 | 理由 |
| --- | --- | --- |
| `shared/types/settings.ts` | `agentOverrides` / `agentCommandOverrides` | 两份副本 |
| `settings/components/useSettingsPanelState.ts` | `saveBuiltinOverride` / `resetBuiltinOverride` / `getEffectiveAgent` / `getEffectiveAgentCommand` / `startEditAgent` / `saveAgentOverride` / `editingPresetId` / `editingValue` | 全部为副本服务 |
| `settings/components/BuiltInAgentsSection.tsx` | 双击命令行行内编辑 + 相关 props | 与表单重复，且是漂移源 |
| `terminal/components/TerminalView.tsx` | `agentCommandOverride` 读取与透传 | 改读 store |
| `terminal/components/TerminalViewBase.tsx` | `agentCommandOverride` prop 与 `cmdOverride` 分支 | 同上 |
| `terminal/components/terminalCache.ts` | `agentCommandOverrides` 参数 | 同上 |
| `terminal/components/terminalAgentSwitch.ts` | 同上 | 同上 |
| `shared/hooks/useProjectActions.ts` | 第三参 `config.agentCommandOverrides` | 同上 |
| `settings/hooks/appConfigNormalize.ts` | 两个字段的默认值与归一化 | 字段已删 |

### 2.5 终端改读 store

```ts
// terminalCache.ts —— 之前
const agent = await getAgent(agentId).catch(() => null);
const cmd = agentCommandOverrides?.[agent.id] ?? agent.command;

// 之后
const agent = useAgentStore.getState().byId(agentId);
if (!agent) return;                       // 未加载 / 不存在
bk.launchAgentInTerminal(resolvedKey, agent.command, agent.args);
```

```tsx
// TerminalViewBase.tsx —— 之前
const cmd = cmdOverride ?? agent.command;

// 之后
const cmd = agent.command;                 // 唯一来源
```

**降级行为**：store 未加载时 `byId` 返回 `undefined`。终端此时**不启动** agent（而不是猜一个命令）。因为「猜」正是原来 `cmdOverride ?? agent.command` 的问题 —— 它让一个过期的值赢过真相。

### 2.6 `List Models Args` 互斥（R5①）

```tsx
// AgentForm.tsx
const chatTransport = transportOf(buildChatLaunch(t.chatLaunch, t.chatInprocess));
const sessionScoped = chatTransport === 'acp' || chatTransport === 'pi-rpc';

{!sessionScoped && <ArgListEditor label="List Models Args" … />}
{sessionScoped && (
  <p className="text-[0.7em] text-text-muted">
    Model list comes from the agent protocol. A CLI list would return
    `provider/model` ids that cannot be written back.
  </p>
)}
```

判据与后端 `supports_session_config()` 同源（ACP / PiRpc 都是 `ConfigCapability::SessionConfig`）。
`ArgListEditor` 与 `chatInprocess` 均已存在（上一任务 `chat-launch-unify` 的产物），直接复用。

**必须渲染测试断言 DOM**，不能只断言源码出现标识符（spec §10.6 的教训：`const configWritable = true` 变异漏抓）。

### 2.7 `Detection` 类型往返（R5②）

```ts
// agentFormState.ts —— 之前
detectionCmd: form.detection?.type === 'command' ? form.detection.target : '',
// → directory 类型的 target 被丢掉，反向恒构造成 command

// 之后
detectionType: form.detection?.type ?? 'command',
detectionTarget: form.detection?.target ?? '',
```

```ts
// AgentForm buildConfig
detection: t.detectionTarget.trim()
  ? { type: t.detectionType, target: t.detectionTarget.trim() }
  : null,
```

UI 上 `type` 用两个 radio / 一个 select（只有两个选项）。

## 3. 内置 agent 仍完全可改

**这是明确的产品要求**（二进制参数不可能覆盖所有用法）。本设计不削弱它：

| 能力 | 保留方式 |
| --- | --- |
| 改 `command` / `args` / `chat` / `prompt_args` / `detection` / `deploy` | 打开完整 `AgentForm` → `saveAgent()` |
| 恢复出厂 | `Reset` → `resetAgent()` |
| 改 `skill_path` | 行内编辑 → `saveAgent()` |
| 开关 `enabled` | → `saveAgent()` |

与自定义 agent 的唯一差别：`is_builtin` 身份 + 有 Reset。

**为什么这样就没有漂移**：所有写入都经 `saveAgent`，它落盘后立刻 `refresh`。不存在「只写了一半」的中间状态。

## 4. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| store 未加载时终端取不到 agent，chat/TUI 起不来 | 启动时 `refresh()`；`byId` 未命中时终端**不启动**并记 `console.warn`（不静默猜） |
| 删除 `agentCommandOverrides` 后用户已有的该配置项残留 | `appConfigNormalize` 的「未建模键原样带过」契约会保留它，但不再被读；无需迁移（它本来就是前端的临时副本） |
| 5 个调用方漏改成 `saveAgent` | `grep invoke('add_agent')` / `invoke('remove_agent')` 应只剩 API 层两处（源码护栏） |
| 内置 agent 覆盖后 `is_builtin` 丢失 | `saveAgent` 前 `{ ...agent, is_builtin: true }`（现状已如此，保留） |

**回滚点**：Step 1（建 store + 写出口）落地后旧路径仍可用，可单独回滚 Step 2/3。

## 5. 分步计划（详见 implement.md）

1. **Step 1 · store + 写出口**：建 `agentStore` + `saveAgent`/`resetAgent`；`useAppConfig` 启动时 refresh。旧路径不动。
2. **Step 2 · 消费点改读 store**：终端（`terminalCache` / `TerminalViewBase` / `terminalAgentSwitch` / `useProjectActions`）+ 设置页（`SettingsView` / `SettingsPanel` / `ProjectPanel` / Skill 页）。
3. **Step 3 · 删除两份副本**：`settings.ts` 两字段 + `useSettingsPanelState` 六个函数 + 双击行内编辑 + `appConfigNormalize` 归一化。
4. **Step 4 · 修两个 bug**：`List Models Args` 互斥 + `Detection` 类型往返。
5. **Step 5 · 收尾**：`pnpm check:quick` + `cargo test` + spec 更新。
