import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 「一次性瞬时反馈」的唯一实现（复制 ✓ / 保存 ✓ / 已复制标签 …）。
 *
 * 第一性原理：这类反馈的存活规则只有一条 —— **一次触发后亮一段时间，到期自动熄灭；
 * 卸载即取消**。此前该规则被 4 处各自手写（`copied` state + `setTimeout`），其中
 * 3 处没有清理（卸载后悬空 setState），时长还各自为政（1500 / 2000ms）。
 * 重复 3 次以上按仓库 DRY 规则必须抽象，收敛到这里。
 *
 * 返回对象而非元组：与仓库其他 hook 的 `{ state }` + `{ action }` 约定一致
 * （`hook-guidelines.md`「返回对象，包含状态值和操作回调」）。
 */
export function useTransientFlag(durationMs: number): {
  flag: boolean;
  flash: () => void;
} {
  const [flag, setFlag] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载即取消：反馈态属于易失 UI，绝不允许跨生命周期。
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    [],
  );

  const flash = useCallback(() => {
    // 连续触发重置计时：第二次覆盖第一次的剩余时间，避免「亮了一下就灭」
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setFlag(false);
    }, durationMs);
    setFlag(true);
  }, [durationMs]);

  return { flag, flash };
}
