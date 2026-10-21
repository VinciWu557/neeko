import { useCallback, useRef } from 'react';

import type { SequencedEvent } from '@/shared/types/agentChat';

/**
 * 暂存「会话 id 赋值之前到达」的事件，并在拿到 id 后一次性应用。
 *
 * # 为什么需要暂存
 *
 * 后端在 `create()` 里就 emit 了 `SessionStart`（带 `config_options`：会话内
 * 模型列表 / 推理档位 / 模式），而它到达前端时 `await startAgentChat()` /
 * `await openAgentChat()` **还没返回**，`sessionIdRef` 仍是空 —— 没有 id 就无法
 * 判断这条事件属于哪个会话。于是先按原序列暂存，赋值后按 id 过滤再应用。
 *
 * # 为什么消费必须共享
 *
 * 消费逻辑曾内联在 `handleSend` 里；新增「选中 agent 先开静默会话」时忘了复制，
 * 结果静默会话的 `SessionStart` 永远躺在暂存区 —— 表现为「会话建好了，但模型
 * 列表还是会话外那份（`--list-models` 的 `provider/model` 复合串）」。
 *
 * 两条路径（发消息 / 静默开会话）现在都调同一个 `drain`，不可能再漂移。
 */
export interface PendingEventDrain {
  /** 暂存一条尚未能确定归属的事件。 */
  buffer: (ev: SequencedEvent) => void;
  /** 应用 `sid` 名下所有已暂存的事件，并清空暂存区。 */
  drain: (sid: string) => void;
  /** 由调用方在 `applyEvent` 定义后注入 —— 避免 hook 依赖声明顺序（TDZ）。 */
  setApplier: (apply: (ev: SequencedEvent) => void) => void;
}

export function usePendingEventDrain(): PendingEventDrain {
  const pendingRef = useRef<SequencedEvent[]>([]);
  // `applyEvent` 定义在调用方文件的后半段。用 ref 持有最新引用，
  // 既避开「hook 早于 const 定义」的 TDZ，也不让 drain 依赖声明顺序。
  const applyRef = useRef<((ev: SequencedEvent) => void) | null>(null);

  const buffer = useCallback((ev: SequencedEvent) => {
    pendingRef.current.push(ev);
  }, []);

  const drain = useCallback((sid: string) => {
    const apply = applyRef.current;
    const buffered = pendingRef.current;
    pendingRef.current = [];
    if (!apply) return;
    for (const seqEv of buffered) {
      if (seqEv.session_id === sid) apply(seqEv);
    }
  }, []);

  const setApplier = useCallback((apply: (ev: SequencedEvent) => void) => {
    applyRef.current = apply;
  }, []);

  return { buffer, drain, setApplier };
}
