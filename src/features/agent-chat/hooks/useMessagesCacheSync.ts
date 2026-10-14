/**
 * 消息缓存同步：messages 变更时写入 tab 级缓存（解决切换 tab 后消息丢失问题）。
 * 自 useAgentChat 抽出（ratchet 拆分，行为零漂移）。
 */

import { useEffect } from 'react';

import { saveCachedMessages } from '../components/messageCache';
import type { ChatMessage } from '../components/messageModel';

export function useMessagesCacheSync(tabId: string, messages: ChatMessage[]): void {
  useEffect(() => {
    saveCachedMessages(tabId, messages);
  }, [tabId, messages]);
}
