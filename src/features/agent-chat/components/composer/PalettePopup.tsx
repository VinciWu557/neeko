import type { EditorView } from '@tiptap/pm/view';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';

import ComposerPalette from '../ComposerPalette';
import type { PaletteItem, PaletteKind } from '../paletteSources';

/**
 * suggestion 引擎需要的命令式接口（经 `ReactRenderer.ref` 暴露）：
 * 引擎的 `render().onKeyDown` 同步转发到这里 —— 弹层自己回答「是否已消费」，
 * 消费了引擎就短路（PM 不再走其他 handler）。10-21 的
 * `handleKeyDown → boolean` 契约在 ProseMirror 插件优先级下保持同形。
 */
export interface PalettePopupHandle {
  onKeyDown: (event: KeyboardEvent, view: EditorView) => boolean;
}

export interface PalettePopupProps {
  kind: PaletteKind;
  items: PaletteItem[];
  emptyText: string;
  /** suggestion 引擎的 command：选中候选后插入 chip 并替换触发段。 */
  command: (item: PaletteItem) => void;
}

/**
 * ComposerPalette 的 suggestion 桥接：持有高亮状态，键盘导航由引擎转发。
 *
 * 关闭路径不归本组件管 —— 引擎在 active 时自己消费 Escape（dispatchExit），
 * onExit 里卸载渲染器。候选为空时 onKeyDown 恒 false：除 Escape（引擎已消费）
 * 外的按键全部放行，Enter 回到发送路径（10-21 空态契约）。
 */
const PalettePopup = forwardRef<PalettePopupHandle, PalettePopupProps>(function PalettePopup(
  { kind, items, emptyText, command },
  ref,
) {
  const [highlight, setHighlight] = useState(0);

  // query 变化 → 引擎递来新 items 数组 → 高亮回 0（与 10-21 行为一致）。
  useEffect(() => {
    setHighlight(0);
  }, [items]);

  // 不给 deps：每次渲染重建 handle，保证引擎转发时读到的 items/highlight 是最新的。
  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (items.length === 0) return false;
      const index = Math.min(highlight, items.length - 1);
      switch (event.key) {
        case 'ArrowDown':
          setHighlight(Math.min(index + 1, items.length - 1));
          return true;
        case 'ArrowUp':
          setHighlight(Math.max(index - 1, 0));
          return true;
        case 'Enter':
        case 'Tab':
          // Shift+Enter 是换行语义，不属于弹层（放行给编辑器）。
          if (event.shiftKey) return false;
          command(items[index]);
          return true;
        default:
          return false;
      }
    },
  }));

  return (
    <ComposerPalette
      kind={kind}
      items={items}
      highlight={Math.min(highlight, items.length - 1)}
      emptyText={emptyText}
      onHighlight={setHighlight}
      onPick={(index) => command(items[index])}
    />
  );
});

// 不再外包 React.memo：引擎每次 onUpdate 递来的 items 都是新数组（identity 恒变），
// memo 比较永不命中，属死重（quality-guidelines「必需模式 2」的豁免判据）。
export default PalettePopup;
