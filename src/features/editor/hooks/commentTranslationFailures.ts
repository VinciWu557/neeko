/**
 * 注释翻译失败的上报策略（纯函数 + 单一副作用点）。
 *
 * ## 为什么独立成文件
 *
 * `useCommentTranslateActions` 贴着 `check_component_size` 的 300 行 ratchet 红线。
 * 这段逻辑有两个变化理由（分类归属 + 通知措辞），与「翻译状态机」无关，
 * 抽出来同时满足红线与单一职责。
 *
 * ## 两类失败为什么要分开处置
 *
 * | 类型 | 起因 | 用户动作 |
 * | --- | --- | --- |
 * | `validation` | 译文回来了但没过校验（占位符丢失 / 代码被译 / 过短） | 点失败位置的 chip 只重试该组 |
 * | `transport` | 压根没拿到译文（断网 / Agent 崩溃 / 超时） | 右下角通知一条告警，重试单组无意义 |
 *
 * 判据来自引擎产生失败时的标注（`TranslateSegmentsResult.failureKinds`），
 * **不是**从 reason 字符串反推 —— 模型的报错文案是自由文本，可能恰好包含
 * `too short` 之类的校验词。
 */
import { useNotificationStore } from '@/shared/store/notificationStore';

import type { FailureKind } from '../comment/translateSegments';

/** 一次翻译作业里传输层失败的汇总。 */
export interface TransportFailureReport {
  /** 受影响的地址数。 */
  count: number;
  /** 首个失败原因（同一批失败通常同因，拼 274 条文案没人读）。 */
  detail: string;
}

/**
 * 汇总传输层失败。
 *
 * 没有传输层失败时返回 `null` —— 调用方据此决定是否发通知，
 * 把「该不该上报」的判断也留在本文件，避免散落。
 */
export function summarizeTransportFailures(result: {
  failureKinds: Record<string, FailureKind>;
  failureReasons: Record<string, string>;
}): TransportFailureReport | null {
  const addresses = Object.entries(result.failureKinds)
    .filter(([, kind]) => kind === 'transport')
    .map(([address]) => address);

  if (addresses.length === 0) return null;

  return {
    count: addresses.length,
    detail: result.failureReasons[addresses[0] ?? ''] ?? 'unknown error',
  };
}

/**
 * 把传输层失败投到右下角通知中心。
 *
 * 校验失败**不**走这里：那是常态（模型偶尔丢占位符），报出来只会把通知变成噪声，
 * 而失败位置的 chip 已经说明了问题。
 */
export function notifyTransportFailures(report: TransportFailureReport): void {
  useNotificationStore.getState().addNotification({
    type: 'error',
    title: '注释翻译失败',
    message: `${report.count} 处未翻译：${report.detail}`,
  });
}
