import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * 消息流的自动跟随滚动（从 `AgentChatTabView` 抽出，纯滚动关注点）。
 *
 * - 只在消息**数量**真实增长时跟随（对齐 Synara §14.11）；
 * - 跟随前开启 100ms 程序化滚动保护窗，防止自动跟随打断用户手动上滚；
 * - DOM refs（`chatEnd` / 滚动容器）由本 hook 持有并返回，调用方挂到 JSX 上
 *   （滚动容器还要交给 `MessageList` 的虚拟器）。
 */
export function useChatAutoFollow(messageCount: number): {
  chatEndRef: RefObject<HTMLDivElement>;
  chatScrollRef: RefObject<HTMLDivElement>;
} {
  const chatEndRef = useRef<HTMLDivElement>(null);
  /// 滚动容器（.wa-chat）—— MessageList 虚拟器据此计算可见窗口
  const chatScrollRef = useRef<HTMLDivElement>(null);
  /// 程序化滚动保护 — 防止用户手动滚动时被自动跟随打断
  const programmaticScrollUntilRef = useRef(0);
  /// 上一条消息数量 — 仅真实消息变化时触发自动跟随
  const messageCountRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    // 自动跟随信号 — 仅基于真实消息变化
    const shouldFollow = messageCount > messageCountRef.current;
    messageCountRef.current = messageCount;

    if (shouldFollow) {
      // 程序化滚动保护窗口
      programmaticScrollUntilRef.current = Date.now() + 100;
      scrollToBottom();
    }
  }, [messageCount, scrollToBottom]);

  return { chatEndRef, chatScrollRef };
}
