import { buildScrollKey } from '@/shared/utils/scrollMemory';

import type { DiffSource } from './types';

/**
 * diff 滚动记忆的身份与让位规则（唯一铸造点在此）。
 *
 * 消费者：`DiffView`（组件接线）；机制本体在 `@/shared/hooks/useScrollMemory`。
 */

/**
 * 滚动身份：workspace 是 owner，combined 与单文件用不同 sub；
 * 显式导航意图（scrollToPath）由 `diffScrollMemoryEnabled` 让位。
 */
export function diffScrollMemoryKey(
  diffSource: DiffSource | undefined,
  combined: boolean | undefined,
  filePath: string,
): string {
  return buildScrollKey(
    'editor.diff',
    diffSource?.workspace.key ?? null,
    combined ? 'combined' : filePath,
  );
}

/**
 * 滚动记忆是否启用：显式导航意图（`scrollToPath`，如 Git Log 跳转到某文件）存在时让位 ——
 * 不恢复、不采集并作废旧记忆，避免意图解除后旧位置反扑。
 */
export function diffScrollMemoryEnabled(scrollToPath: string | null | undefined): boolean {
  return scrollToPath == null;
}
