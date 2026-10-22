import { useCallback, useState } from 'react';

import type { ConfigCapability, SessionConfigOption } from '@/shared/types/agentChat';
import { modelAvailabilityOf, type ModelAvailability } from '@/shared/utils/modelTarget';

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
  /** 当前会话的配置项（含模型列表）。非 `ready` 时为空数组。 */
  options: SessionConfigOption[];
  /**
   * 模型/配置项的**可用状态**（唯一判据，见 `shared/utils/modelTarget.ts`）。
   *
   * 这里直接给出 `ModelAvailability` 而不是 `{phase, capability}` 两字段：
   * 后者是 9 种组合的自由空间（只 4 种可达），每个消费点都要自己 switch
   * 两个维度 —— 4 处判据自然漂移。收成一个 union 后非法状态无法表达。
   */
  availability: ModelAvailability;
  /** 整体替换（`session_start` / `config_option_update` 都是全量语义）。 */
  replace: (options: SessionConfigOption[]) => void;
  /** 由 `SessionStart.capabilities.config` 设置（会话建立时调用一次）。 */
  setCapability: (next: ConfigCapability) => void;
  /**
   * 消费 `session_start` 的配置相关字段（能力位 + 选项）。
   *
   * 为什么收成一个动作：两者的**顺序是契约**（先能力后选项，否则会闪一下
   * loading 态）。分两次调用让调用方有机会写反，而写反不会报错、只表现为
   * 一次多余渲染。
   */
  applySessionStart: (
    capability: ConfigCapability | undefined,
    options: SessionConfigOption[] | undefined,
  ) => void;
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
  /**
   * 能力位取自 `SessionStart.capabilities.config`。
   *
   * 初值是 `session_config` 而非 `none`：**会话还没建立时不该断言「不支持」**。
   * 真正的判定发生在 `setCapability` 被调用时（`SessionStart` 到达）；
   * 在那之前 `phase` 是 `loading`，UI 显示加载态而不是隐藏控件。
   */
  const [capability, setCapabilityState] = useState<ConfigCapability>('session_config');
  /**
   * 握手是否已完成（`session_start` 到达过）。
   *
   * 用来把「还没收到握手」与「握手完成但 agent 没下发配置项」区分开 ——
   * 前者是 `loading`，后者是 `ready`（空列表）。没有它，第二种会永久卡在
   * `loading`，UI 表现为「模型列表永远灰着」。
   */
  const [handshaken, setHandshaken] = useState(false);

  const replace = useCallback((next: SessionConfigOption[]) => {
    // 协议要求整体替换：换模型可能连带改变 thought_level 的可选项，
    // 局部合并会留下与真实状态不符的陈旧选项。
    setOptions(next);
  }, []);

  /**
   * 由 `SessionStart.capabilities.config` 调用。
   *
   * **顺序要紧**：先设能力再设选项（`replace`）。反过来会让「有选项但能力
   * 未定」的瞬间被渲染成 `loading`，闪一下加载态。
   */
  const setCapability = useCallback((next: ConfigCapability) => {
    setCapabilityState(next);
  }, []);

  const applySessionStart = useCallback(
    (
      nextCapability: ConfigCapability | undefined,
      nextOptions: SessionConfigOption[] | undefined,
    ) => {
      // `config` 缺失 = 旧后端事件形状。按 `session_config` 处理：既有行为
      // （ACP 是主力传输）不能因一次字段新增而全部消失。
      setCapabilityState(nextCapability ?? 'session_config');
      // 协议要求整体替换：换模型可能连带改变 thought_level 的可选项，
      // 局部合并会留下与真实状态不符的陈旧选项。
      setOptions(nextOptions ?? []);
      // `session_start` 到达即「握手完成」—— 此后不会再有第二次握手事件。
      // 没有这一行，`session_config` + 空 `config_options` 会让 `phase` 永久停在
      // `loading`：模型列表永远灰、提示永远说 "Models are loading…"。
      // 后端契约（`capability_probe`）要求声明 `SessionConfig` 就必须带配置项，
      // 但前端不能依赖后端永远正确 —— 那正是 P1/P8 的教训。
      setHandshaken(true);
    },
    [],
  );

  const setOption = useCallback(
    (configId: string, value: string | boolean) => {
      const sessionId = getSessionId();
      if (!sessionId) return;
      void setAgentConfigOption(sessionId, configId, value).catch(() => undefined);
    },
    [getSessionId],
  );

  const reset = useCallback(() => {
    setOptions([]);
    setHandshaken(false);
    // 回到「未知」而不是「不支持」—— `reset` 的语义是「换会话了」，
    // 新会话的能力还没到，此时断言 `none` 会让控件瞬间消失再出现。
    setCapabilityState('session_config');
  }, []);

  // 握手已完成 ⟺ `session_start` 到过，或选项已经来了（`config_option_update`
  // 也可能先于握手到达，两者等价地说明「会话就绪」）。
  const ready = handshaken || options.length > 0;
  const availability = modelAvailabilityOf(capability, ready ? 'ready' : 'loading');

  return {
    options,
    availability,
    replace,
    setCapability,
    applySessionStart,
    setOption,
    reset,
  };
}
