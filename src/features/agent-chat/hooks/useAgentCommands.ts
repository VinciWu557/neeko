import { useEffect, useState } from 'react';

import type { AgentCommandEntry } from '@/shared/types/agentChat';

import { listAgentCommands } from '../api/agentChatApi';

/**
 * 命令列表的**会话期内**缓存（按 agentId，不落盘 —— design §3：命令列表在
 * 会话期内不变）。模块级 Map 让「切走再切回」不重新发起查询；失败的 agent
 * 不进缓存，重新挂载可重试（同一挂载内由 `loaded` 键挡住重试）。
 */
const commandCache = new Map<string, AgentCommandEntry[]>();

/**
 * agent 的 slash 命令列表（`/` 补全数据源）。
 *
 * # 能力位是唯一开关（R2 修订版）
 *
 * `enabled` 来自 `SessionStart.capabilities.commands` —— 能力位 false 时
 * **连查询都不发**（不挂 slash 源），不靠「试查询报错」判定能力（那是
 * `agent-chat-transports.md` §10.1 明文修掉的 P1 缺陷形态）。
 *
 * # 错误与空列表
 *
 * 查询失败（含传输不支持但能力位误标 true 的违约场景）回空数组 —— 前端
 * 显示空态文案，不弹错误打断输入；静默降级在这里是安全的，因为入口
 * 显隐已由能力位单独裁决。
 *
 * # 为什么读缓存发生在渲染期而不是 effect 里
 *
 * 缓存命中 / 能力位关闭都属于「纯派生」，setState 同步写 effect 会触发
 * 级联渲染（eslint 报 error）；只有异步回包真正需要落 state，按 agentId
 * 分键存，避免切 agent 时读到上一个 agent 的在途结果。
 */
export function useAgentCommands(agentId: string | null, enabled: boolean): AgentCommandEntry[] {
  const key = enabled && agentId ? agentId : null;
  const [loaded, setLoaded] = useState<Record<string, AgentCommandEntry[]>>({});

  useEffect(() => {
    if (!key || commandCache.has(key) || key in loaded) return;
    let cancelled = false;
    void listAgentCommands(key)
      .then((list) => {
        commandCache.set(key, list);
        if (!cancelled) setLoaded((prev) => ({ ...prev, [key]: list }));
      })
      .catch((e) => {
        console.error('[AgentChat] Failed to list agent commands:', e);
        if (!cancelled) setLoaded((prev) => ({ ...prev, [key]: [] }));
      });
    return () => {
      cancelled = true;
    };
  }, [key, loaded]);

  return (key && (commandCache.get(key) ?? loaded[key])) || [];
}
