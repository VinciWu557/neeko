import { create } from 'zustand';

import type { AgentConfig } from '@/shared/types';

/**
 * Agent 配置的**唯一**前端读入口。
 *
 * # 为什么只有一份
 *
 * 后端 `AgentManager` 是唯一真相（`add_agent` 写覆盖层、`list_agents` 读生效值、
 * `adapter_for` 用它 spawn）。前端曾为「改完立刻看到」另存两份副本
 * （`config.agentOverrides` / `config.agentCommandOverrides`），结果是三份可写、
 * 三份可读，一致性维护点分散到各消费方 —— 实测产生过两处漂移。
 *
 * 现在只有这一份缓存，写操作（`saveAgent` / `resetAgent`）落盘后调 `refresh()`。
 *
 * # 三条不变量
 *
 * 1. **幂等加载**：`ensure()` 可被任意多个消费方并发调用，只会真正请求一次。
 *    消费方不需要自己判断「加载过没有」—— 那是副本的来源。
 * 2. **陈旧响应丢弃**：`refresh()` 带 generation 守卫，乱序返回的旧快照不会
 *    覆盖新快照（同 `state-management.md` 的 git status generation 方案）。
 * 3. **失败不清空**：保留上次成功的快照。置空会让终端在瞬时 IPC 故障后
 *    失去全部 agent，比继续用旧数据更糟。
 */

interface AgentStoreState {
  /**
   * 后端 `list_agents` 的快照。
   *
   * `null` = 尚未加载；`[]` = 后端确实没有 agent。两者必须区分 —— 混用会让
   * 首次渲染闪一下「无 agent」。
   */
  agents: AgentConfig[] | null;
  /** 是否已有在途加载（`ensure` 幂等的依据）。 */
  loading: boolean;
  /** 强制重新拉取。写操作后由 API 层调用。 */
  refresh: () => Promise<void>;
  /** 幂等加载：未加载时才请求，已加载或加载中则复用。 */
  ensure: () => Promise<void>;
  /**
   * 按 id 取快照里的 agent。
   *
   * **同步**：终端在 PTY 就绪回调里调用它，那里不能 await。未命中返回
   * `undefined` —— 调用方据此**不启动** agent，而不是猜一个命令。
   * 响应式消费请用 `useAgentStore((s) => s.agents?.find(...))`。
   */
  byId: (id: string) => AgentConfig | undefined;
  /** 直接替换快照（测试夹具；生产路径一律走 `refresh` / `ensure`）。 */
  setAgents: (agents: AgentConfig[]) => void;
}

/**
 * 取数函数（由 `features/agent/api` 注入）。
 *
 * 为什么不直接 import API：`shared/` 不得依赖 `features/`（分层约束），而 API
 * 模块需要 import 本 store 做写后刷新 —— 互相引用会成环。注入让依赖方向单向。
 *
 * 放模块级变量而不是 store 状态：它不是「状态」，是装配件；放进 state 会让它
 * 参与每次快照比较，也诱使消费方去读它。
 */
let loadAgents: (() => Promise<AgentConfig[]>) | null = null;

/** 注入取数函数。由 `features/agent/api/agentApi.ts` 在模块加载时调用。 */
export function setAgentLoader(loader: () => Promise<AgentConfig[]>) {
  loadAgents = loader;
}

/**
 * generation 计数器 —— 只有最新一代的响应可写入。
 *
 * 场景：`ensure()` 的 preload 在途 → 用户保存 → 保存触发的 `refresh()` 先落地
 * → preload 的旧响应后落地 → store 回退到保存前的快照 → 终端启动旧命令。
 * 这正是本类型要消灭的失败模式，所以守卫必须有。
 */
let generation = 0;

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  agents: null,
  loading: false,

  refresh: async () => {
    if (!loadAgents) {
      // 未注入时明确报错而不是静默返回空列表 —— 后者会让「没接上」看起来像
      // 「后端确实没有 agent」。
      throw new Error('agentStore: loader not registered (features/agent/api must load first)');
    }
    const mine = ++generation;
    set({ loading: true });
    try {
      const agents = await loadAgents();
      if (mine === generation) {
        set({ agents });
      }
    } finally {
      // 只有最新一代负责清 loading —— 早期响应不能替别人收尾。
      if (mine === generation) {
        set({ loading: false });
      }
    }
  },

  ensure: async () => {
    const { agents, loading } = get();
    // 已加载或有在途请求 → 复用，不重复请求。这让「每个消费方都调一次
    // ensure()」变得安全，从而不需要副本。
    if (agents !== null || loading) return;
    await get().refresh();
  },

  byId: (id) => get().agents?.find((a) => a.id === id),

  setAgents: (agents) => set({ agents, loading: false }),
}));

/**
 * 重置 generation 计数器（**仅供测试**）。
 *
 * generation 是模块级状态：测试用例之间必须归零，否则上一例的在途请求会让
 * 下一例的 `refresh` 被判为陈旧而丢弃。生产代码不得调用。
 */
export function __resetGenerationForTests(): void {
  generation = 0;
}

/**
 * 取一个 agent，必要时先加载缓存。
 *
 * 为什么需要它而不是直接 `byId`：终端在 PTY 就绪回调里取 agent 命令，而
 * 启动期的会话恢复**可能早于 preload 完成**。只查缓存会让用户得到一个空
 * 终端；等一次幂等加载则总能拿到（除非该 agent 真的不存在）。
 *
 * 已加载时是同步返回（`ensure` 立即 resolve），不引入额外延迟。
 */
export async function resolveAgent(id: string): Promise<AgentConfig | undefined> {
  const store = useAgentStore.getState();
  if (store.agents === null) {
    await store.ensure();
  }
  return useAgentStore.getState().byId(id);
}
