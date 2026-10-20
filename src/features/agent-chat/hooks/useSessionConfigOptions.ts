import { useCallback, useState } from 'react';

import type { SessionConfigOption } from '@/shared/types/agentChat';

import { setAgentConfigOption } from '../api/agentChatApi';

/**
 * 会话配置项（ACP `configOptions`）的状态与写入。
 *
 * # 为什么单独抽出来
 *
 * `useAgentChat` 已经承载了消息流、附件、审批、恢复等职责，贴近 300 行 ratchet
 * 的既有基线上限。配置项是**独立的一组事实**：它只关心「当前有哪些选项」「怎么改」，
 * 与消息流无耦合。
 *
 * # 为什么不本地乐观更新
 *
 * 协议规定 `session/set_config_option` 的响应返回**全量**配置，且 agent 可以主动
 * 推送 `config_option_update`（典型场景：rate limit 时 fallback 换模型）。本地先改
 * 会让 UI 短暂显示一个 agent 并未接受的选项；等事件回来再更新则始终与真实状态一致。
 */
export interface SessionConfigState {
  /** 当前会话的配置项（含模型列表）。 */
  options: SessionConfigOption[];
  /** 整体替换（`session_start` / `config_option_update` 都是全量语义）。 */
  replace: (options: SessionConfigOption[]) => void;
  /** 下发一个配置项变更。 */
  setOption: (configId: string, value: string | boolean) => void;
  /**
   * 清空。
   *
   * 切换 agent 或会话结束时必须调用：否则上一个 ACP 会话的 `model_config` 控件会
   * 残留在新会话的 composer 上 —— 那些选项对新 agent 毫无意义，而且改它们会发出
   * 指向不存在的 `configId` 的请求。
   */
  reset: () => void;
}

export function useSessionConfigOptions(
  getSessionId: () => string | null | undefined,
): SessionConfigState {
  const [options, setOptions] = useState<SessionConfigOption[]>([]);

  const replace = useCallback((next: SessionConfigOption[]) => {
    // 协议要求整体替换：换模型可能连带改变 thought_level 的可选项，
    // 局部合并会留下与真实状态不符的陈旧选项。
    setOptions(next);
  }, []);

  const setOption = useCallback(
    (configId: string, value: string | boolean) => {
      const sessionId = getSessionId();
      if (!sessionId) return;
      void setAgentConfigOption(sessionId, configId, value).catch(() => undefined);
    },
    [getSessionId],
  );

  const reset = useCallback(() => setOptions([]), []);

  return { options, replace, setOption, reset };
}
