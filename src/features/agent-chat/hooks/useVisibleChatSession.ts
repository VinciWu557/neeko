/**
 * 通知焦点抑制事实源上报（prd R2.1，源 A）。
 *
 * 前提事实：AgentChatTabView 仅在标签激活时渲染（PaneContent 按 activeTab 分发），
 * 因此「本 hook 挂载且持有 sessionId」⇔「该会话对用户可见」。
 * 上报失败静默 —— 只影响通知抑制判断，不影响会话本身。
 */

import { useEffect } from 'react';

import { setVisibleChatSession } from '../api/agentChatApi';

export function useVisibleChatSession(sessionId: string | undefined): void {
  useEffect(() => {
    if (!sessionId) {
      return undefined;
    }
    void setVisibleChatSession(sessionId);
    return () => {
      void setVisibleChatSession(null);
    };
  }, [sessionId]);
}
