import React, { useEffect, useMemo, useRef } from 'react';

import { segmentHighlights, tokenizeHighlights } from './paletteHighlight';

interface ComposerMirrorProps {
  /** 当前输入文本；tokenize 只随它重算（useMemo），不逐渲染扫描。 */
  text: string;
  /** IME 组合期视觉隐藏（visibility），**保持挂载**：WebKit 下透明文字会隐藏
   * 组合文本（AC8 邻近回归），且 unmount/remount 本身是组合期 DOM 抖动源。 */
  suspended: boolean;
  /** textarea 的 ref —— 滚动跟随从这里读 scrollTop。 */
  textareaRef: { current: HTMLTextAreaElement | null };
}

/**
 * 镜像高亮层（AC11，design §10）：textarea 文字透明（`caret-color` 保留可见），
 * 本层在同排版（`.composer-mirror` 与 textarea 的盒模型逐项一致）下方逐字渲染
 * 全部文本，把 `/命令` 与 `@文件` 区间渲染成高亮 token。
 *
 * token 判据与弹层触发同源（paletteHighlight 复用 `triggerStartAt`），禁止第二套
 * 正则 —— 漂移会出现「高亮了但弹层不认」的矛盾形态。
 *
 * `aria-hidden` + `pointer-events: none`：只渲染，不交互、不进可达树；
 * 本层永不自行滚动（`overflow: hidden`），scrollTop 只跟随 textarea。
 *
 * 组合期只做 `visibility: hidden`、**不卸载**：重挂载会让 scrollTop 归零
 * （高亮整体错位），且 unmount/remount 是组合期 DOM 抖动源 —— 常驻后滚动同步
 * 天然跨组合期连续。
 */
function ComposerMirror({ text, suspended, textareaRef }: ComposerMirrorProps) {
  const mirrorRef = useRef<HTMLDivElement | null>(null);

  const highlightSegments = useMemo(
    () => segmentHighlights(text, tokenizeHighlights(text)),
    [text],
  );

  // 用户滚 textarea（滚轮 / 方向键）→ 镜像跟随；镜像自身不可滚，无需反向同步。
  // 用原生监听而非宿主的 onScroll：同步职责收在本组件内，宿主只挂载它。
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const sync = () => {
      if (mirrorRef.current) mirrorRef.current.scrollTop = ta.scrollTop;
    };
    ta.addEventListener('scroll', sync);
    return () => ta.removeEventListener('scroll', sync);
  }, [textareaRef]);

  return (
    <div
      ref={mirrorRef}
      className="composer-mirror"
      aria-hidden="true"
      data-testid="composer-mirror"
      style={{ visibility: suspended ? 'hidden' : 'visible' }}
    >
      {highlightSegments.map((seg, i) =>
        seg.kind ? (
          <mark
            key={i}
            className={`composer-token composer-token-${seg.kind}`}
            data-testid={`composer-token-${seg.kind}`}
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </div>
  );
}

export default React.memo(ComposerMirror);
