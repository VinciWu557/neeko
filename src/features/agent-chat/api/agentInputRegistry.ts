import type { WorkspaceSession } from '@/shared/utils/workspaceRef';

/**
 * agent 输入（agent-chat composer）的投递注册表 —— 形态 A（决议 Q5）。
 *
 * **为什么不是 DOM CustomEvent**：`dispatchEvent` 的返回值只表示「有无 preventDefault」，
 * **不表示「有无接收者」**。被删除的 `INSERT_TO_AGENT_INPUT_EVENT` 有三个派发点、
 * 全历史零个监听者（`git log --all -S"addEventListener(INSERT_TO_AGENT_INPUT_EVENT"` → 0 条），
 * 于是「函数存在但什么都不做」，连 `useInsertPromptToWorkspace` 的 clipboard 兜底都进不去 ——
 * 用户按 Enter，什么也没发生。本注册表把「有人接住了吗」变成**结构性能回答**的问题：
 * 未登记即 `false`，派发方因此能降级（clipboard + toast）。
 *
 * 形态照抄本仓两处同构先例：`editor/api/aiActionRegistry.ts`、`editor/api/editorViews.ts`
 * （身份键 + handler + 引用计数卸载 + 未命中 false）。
 *
 * **存储形态 = 嵌套 Map（不是拼字符串身份）**，两条理由：
 * 1. 拼串需要一个保留分隔符，而护栏 `check_terminal_key_mint` 的 G3 判据禁止在
 *    地址 mint 文件（`terminalAddress.ts`；S4 前为 `terminalCache.ts`）之外材质化分隔符
 *    —— 在这里拼串会被自己的护栏拦下；
 * 2. 用 `:` 拼会撞上 10-12 决议 Q7 判死的同一个缺陷（editor tabId 本身含 `:`，
 *    `A` + `:` + `p1` 与 `A:p1` 前缀同形）。
 * 嵌套 Map 的外层键**直接就是 `session.key`**（品牌类型 `WorkspaceKey`），
 * 因此既不铸造第二个键命名空间，也无需反解 —— 红线 12「不从字符串反解身份」自然成立。
 *
 * **本模块不回答「该选哪个 tab」**：那是 `terminal/components/terminalRouting.ts` 的唯一职责
 * （顺序口径全仓只允许它内部那一次 `sort`，见 design §5.3）。所以 `insertAgentInput`
 * 的 `tabId` **必填** —— 可选性只会喂养第二条「取首个」的口径（本任务 R3 的同一族缺陷）。
 */

/**
 * 投递结果：`false` = 本接收端不接本次投递，编排层必须继续降级（决议 Q1）。
 *
 * 返回值是给**注册表机制**的（「有没有人接住」必须能回答，见本模块 docstring），
 * 不是给某个具体接收端的策略位：当前唯一的生产 handler（`useAgentInputRegistration`）
 * **恒返回 true** —— composer 对任何文本都收。所以今日 `insertAgentInput` 给出 false 的
 * **唯一**原因就是「该 (session, tabId) 未登记」（composer 未挂载 / 已卸载）。
 * **不要**把它当成「加业务门禁」的口子（如「流式进行中不许改写」）—— 那类语义属于
 * composer 自己；写在 handler 里会让同一条文本静默改落 PTY，比 no-op 更难诊断。
 */
export type AgentInputHandler = (text: string) => boolean;

interface Registration {
  handler: AgentInputHandler;
  /**
   * 引用计数：同身份多挂载（React StrictMode 双挂载）时 count > 1，
   * 卸载只减不删 —— 先卸载的那次不得摘掉仍存活页面的 handler。
   */
  count: number;
}

/** `session.key` → (`tabId` → 登记项)。外层键是身份投影，不是拼装。 */
const registrations = new Map<string, Map<string, Registration>>();

function tabsOf(session: WorkspaceSession): Map<string, Registration> | undefined {
  return registrations.get(session.key);
}

/** 登记（或替换）某 agent-chat composer 的接收端；同身份重复登记累加引用计数。 */
export function registerAgentInput(
  session: WorkspaceSession,
  tabId: string,
  handler: AgentInputHandler,
): void {
  let tabs = tabsOf(session);
  if (!tabs) {
    tabs = new Map<string, Registration>();
    registrations.set(session.key, tabs);
  }
  const cur = tabs.get(tabId);
  if (cur) {
    tabs.set(tabId, { handler, count: cur.count + 1 });
  } else {
    tabs.set(tabId, { handler, count: 1 });
  }
}

/**
 * 注销：计数减到 0 才移除该 tab 的登记；某 session 下全部 tab 注销后连带移除外层键，
 * 避免 `registrations` 累积空 Map（长会话下的无界增长）。
 * 对不存在的身份是幂等无操作。
 */
export function unregisterAgentInput(session: WorkspaceSession, tabId: string): void {
  const tabs = tabsOf(session);
  if (!tabs) return;
  const cur = tabs.get(tabId);
  if (!cur) return;
  if (cur.count <= 1) tabs.delete(tabId);
  else tabs.set(tabId, { handler: cur.handler, count: cur.count - 1 });
  if (tabs.size === 0) registrations.delete(session.key);
}

/**
 * 投递文本到指定 composer。
 *
 * @returns true = 有接收端且它确认消费；false = 该 (session, tabId) 没有登记的
 *          composer，或接收端自行拒绝。**调用方必须把 false 当作「没落地」处理**
 *          （降级到 clipboard / toast），不许静默忽略 —— 那正是本模块要消灭的形态。
 */
export function insertAgentInput(session: WorkspaceSession, tabId: string, text: string): boolean {
  const entry = tabsOf(session)?.get(tabId);
  return entry ? entry.handler(text) : false;
}
