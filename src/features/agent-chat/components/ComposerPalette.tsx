import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { ComposerPaletteSource, PaletteItem } from './paletteSources';
import { applySelection, findTrigger, triggerOf } from './paletteTrigger';
import type { PaletteKind } from './paletteTrigger';

/**
 * 弹层打开时的内部状态。`index` 是触发符在输入文本中的下标 —— 写回时只替换
 * `[index, cursor)` 段（cursor 可由 `index + 1 + query.length` 推出，不必另存）。
 */
interface PaletteState {
  kind: PaletteKind;
  index: number;
  query: string;
}

interface UseComposerPaletteParams {
  /** 当前输入框文本（受控值），选中候选时以它为写回基准。 */
  input: string;
  sources: readonly ComposerPaletteSource[];
  /** 候选写回入口；`cursor` 是插入后的光标位置（调用方用于恢复光标）。 */
  onReplaceText?: (text: string, cursor: number) => void;
}

/**
 * Composer 补全弹层的状态机（design §2）。
 *
 * 触发与过滤**不另设增量状态**：每次 change 事件都从「当前文本 + 光标」重新
 * 派生 —— 继续输入自然更新 query，Backspace 越过触发符自然关闭，空格自然关闭。
 *
 * # 键盘契约（AC7 的实现基础）
 *
 * `handleKeyDown(e) → boolean`，返回值是「是否已消费」——让调用方据此决定
 * `preventDefault` 并短路后续发送，而不靠调用方猜。弹层未打开（或 IME 组合中）
 * 恒返回 `false`，不干扰现有 Enter 发送 / Shift+Enter 换行。
 *
 * # 中文输入法（AC8）
 *
 * `compositionProps` 要展开到 textarea 上：组合期间（compositionstart → end）
 * 不触发补全、Enter 不选中 —— 否则拼音的 Enter 上屏会被弹层吞掉。不用
 * `nativeEvent.isComposing`（React 合成事件上该字段在某些浏览器滞后一帧）。
 * 返回值 `composing` 是同一状态的响应式镜像，供镜像高亮层门控（design §10）。
 */
export function useComposerPalette({ input, sources, onReplaceText }: UseComposerPaletteParams) {
  const [active, setActive] = useState<PaletteState | null>(null);
  const [highlight, setHighlight] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCursorRef = useRef<number | null>(null);
  const composingRef = useRef(false);
  // IME 组合期的**响应式**镜像（ref 供同步判据，不触发渲染）：镜像高亮层
  // 依据它隐藏 / 恢复 textarea 原生渲染（ChatComposer，design §10）。
  const [composing, setComposing] = useState(false);

  // compositionProps 的 useMemo 依赖为 []，组合结束时的重同步读到的是**当下**的
  // input 与写回回调 —— 用 ref 转发（effect 中同步，渲染期不写 ref），避免闭包过期。
  const inputRef = useRef(input);
  const onReplaceTextRef = useRef(onReplaceText);
  useEffect(() => {
    inputRef.current = input;
    onReplaceTextRef.current = onReplaceText;
  });

  const close = useCallback(() => {
    setActive(null);
    setHighlight(0);
  }, []);

  const items = useMemo(() => {
    if (!active) return [];
    const source = sources.find((s) => s.kind === active.kind);
    return source ? source.getItems(active.query) : [];
  }, [active, sources]);

  // 写回经父级受控 state 回流到 DOM 之后才能 setSelectionRange；
  // 顺带做一次自动增高（与 AgentChatTabView 的输入路径同一套规则）。
  useEffect(() => {
    const cursor = pendingCursorRef.current;
    if (cursor === null) return;
    pendingCursorRef.current = null;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(cursor, cursor);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      if (composingRef.current) {
        close();
        return;
      }
      const text = e.target.value;
      const match = findTrigger(text, e.target.selectionStart ?? text.length);
      const source = match && sources.find((s) => s.kind === match.kind);
      if (!match || !source) {
        close();
        return;
      }
      setActive({ kind: match.kind, index: match.index, query: match.query });
      setHighlight(0);
    },
    [sources, close],
  );

  const handlePick = useCallback(
    (pickedIndex: number) => {
      if (!active) return;
      const item = items[pickedIndex];
      if (!item) return;
      const cursor = active.index + 1 + active.query.length;
      const replacement = `${triggerOf(active.kind)}${item.value} `;
      const applied = applySelection(input, active.index, cursor, replacement);
      pendingCursorRef.current = applied.cursor;
      onReplaceText?.(applied.text, applied.cursor);
      sources.find((s) => s.kind === active.kind)?.onPick?.(item);
      close();
    },
    [active, items, input, onReplaceText, sources, close],
  );

  /**
   * 键盘契约：返回是否已消费该事件。弹层打开时 Enter/Tab 选中候选、不发送；
   * 候选为空时只有 Esc 被消费，其余按键放行（Enter 交给发送）。
   *
   * 消费前先用**真实光标**重新校验触发状态：textarea 的选区变化（点击、Home 等）
   * 不触发 onChange，`active` 里的 index/query 可能已过期 —— 直接消费会在旧位置
   * 写回候选（文本被改错地方，且用户意图的发送被吞）。失效即关闭并放行本次按键。
   * ref 为空（hook 级测试 / 未挂载）跳过校验。
   */
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!active || composingRef.current) return false;
      const el = textareaRef.current;
      if (el) {
        const match = findTrigger(el.value, el.selectionStart ?? el.value.length);
        const source = match && sources.find((s) => s.kind === match.kind);
        if (
          !match ||
          !source ||
          match.kind !== active.kind ||
          match.index !== active.index ||
          match.query !== active.query
        ) {
          close();
          return false;
        }
      }
      if (items.length === 0) {
        if (e.key === 'Escape') {
          close();
          return true;
        }
        return false;
      }
      switch (e.key) {
        case 'ArrowDown':
          setHighlight((h) => Math.min(h + 1, items.length - 1));
          return true;
        case 'ArrowUp':
          setHighlight((h) => Math.max(h - 1, 0));
          return true;
        case 'Enter':
        case 'Tab':
          handlePick(Math.min(highlight, items.length - 1));
          return true;
        case 'Escape':
          close();
          return true;
        default:
          return false;
      }
    },
    [active, items, highlight, handlePick, close, sources],
  );

  const view = useMemo(() => {
    if (!active) return null;
    const source = sources.find((s) => s.kind === active.kind);
    return {
      kind: active.kind,
      items,
      highlight: Math.min(highlight, items.length - 1),
      emptyText: source?.emptyText ?? '',
    };
  }, [active, sources, items, highlight]);

  const compositionProps = useMemo(
    () => ({
      onCompositionStart: () => {
        composingRef.current = true;
        setComposing(true);
      },
      onCompositionEnd: () => {
        composingRef.current = false;
        setComposing(false);
        // WebKit 愈合点：compositionend 与末次 input 事件的顺序在 WebKit 上可能
        // 颠倒 —— 受控值丢了组合末尾的 change，与 DOM 值分叉（透明镜像层与光标
        // 全部错位）。以 DOM 值为准写回受控 state，并保留 WebKit 留下的光标位
        // （经 pendingCursorRef 通道，随本次 input 变更生效）。
        const el = textareaRef.current;
        if (!el) return;
        const domValue = el.value;
        if (domValue === inputRef.current) return;
        const cursor = el.selectionStart ?? domValue.length;
        pendingCursorRef.current = cursor;
        onReplaceTextRef.current?.(domValue, cursor);
      },
    }),
    [],
  );

  return {
    textareaRef,
    view,
    handleChange,
    handleKeyDown,
    handlePick,
    handleClose: close,
    handleHighlight: setHighlight,
    compositionProps,
    composing,
  };
}

interface ComposerPaletteProps {
  kind: PaletteKind;
  items: PaletteItem[];
  highlight: number;
  emptyText: string;
  onHighlight: (index: number) => void;
  onPick: (index: number) => void;
}

/**
 * 数据无关的补全弹层骨架：定位（贴输入框上沿，design §7 —— 不做光标级跟随）
 * 由 `.composer-palette` 样式承担，本组件只负责列表渲染与点击选中。
 *
 * `onMouseDown` 阻止默认行为：否则点击候选会先抢走 textarea 焦点，
 * 写回后的 `focus()` 与光标恢复也会跟着抖一下。
 */
function ComposerPalette({
  kind,
  items,
  highlight,
  emptyText,
  onHighlight,
  onPick,
}: ComposerPaletteProps) {
  return (
    <div
      className="composer-palette"
      role="listbox"
      aria-label={kind === 'slash' ? '命令补全' : '文件补全'}
      aria-orientation="vertical"
    >
      {items.length === 0 && <div className="composer-palette-empty">{emptyText}</div>}
      {items.map((item, i) => (
        <button
          key={`${item.value}:${i}`}
          type="button"
          role="option"
          aria-selected={i === highlight}
          className={`composer-palette-item${i === highlight ? ' active' : ''}`}
          title={item.sublabel}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHighlight(i)}
          onClick={() => onPick(i)}
        >
          <span className="composer-palette-label">{item.label}</span>
          {item.sublabel && <span className="composer-palette-sub">{item.sublabel}</span>}
        </button>
      ))}
    </div>
  );
}

export default React.memo(ComposerPalette);
