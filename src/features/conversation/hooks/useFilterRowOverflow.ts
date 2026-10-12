import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

/**
 * 检测「折叠态筛选行」是否溢出单行（chip 换行到 >1 行）。
 *
 * 比对折叠高度（scrollHeight vs clientHeight）；展开态不测量，容器宽度变化时经 RO 重测。
 * 从 ConversationPanel 的 useLayoutEffect 主体抽出（组件体积 ratchet），行为零漂移。
 */
export function useFilterRowOverflow(
  rowRef: RefObject<HTMLDivElement | null>,
  optionCount: number,
  expanded: boolean,
): boolean {
  const [overflow, setOverflow] = useState(false);

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el || optionCount <= 1) {
      setOverflow(false);
      return;
    }
    const measure = () => {
      // scrollHeight exceeds one line's height => chips wrapped to >1 row
      setOverflow(el.scrollHeight - el.clientHeight > 1);
    };
    if (!expanded) measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!expanded) measure();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [rowRef, optionCount, expanded]);

  return overflow;
}
