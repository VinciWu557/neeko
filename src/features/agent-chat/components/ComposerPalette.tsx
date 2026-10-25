import React, { useEffect, useMemo, useRef } from 'react';

import { PALETTE_GROUP_ICONS } from './paletteIcons';
import { groupPaletteItems } from './paletteSources';
import type { PaletteGroup, PaletteItem, PaletteKind } from './paletteSources';

interface ComposerPaletteProps {
  kind: PaletteKind;
  items: PaletteItem[];
  highlight: number;
  emptyText: string;
  onHighlight: (index: number) => void;
  onPick: (index: number) => void;
}

/**
 * 数据无关的补全弹层：**按分组渲染**（Skills / Commands / Extensions / Files），
 * 每组带图标与标题，行内显示主文本 + 说明。
 *
 * # 键盘与高亮不归它管
 *
 * 触发、过滤、↑↓ 选中、Enter/Tab、Esc 全由 suggestion 引擎接管（见
 * `composer/PalettePopup.tsx`）。本组件只负责「把 items 画成分组列表」与
 * 「点击选中」。但它必须**把高亮行滚进可视区** —— 引擎改的是 `highlight`
 * 下标，滚动是纯渲染层的事，没有别的地方能做。
 *
 * 分组来自 `groupPaletteItems`（顺序由 `PALETTE_GROUP_ORDER` 定，与数据到达
 * 顺序无关）；`highlight` 仍然是**扁平下标**（与引擎的 item 数组同序），
 * 分组只影响渲染结构、不影响下标语义。
 */
function ComposerPalette({
  kind,
  items,
  highlight,
  emptyText,
  onHighlight,
  onPick,
}: ComposerPaletteProps) {
  const sections = useMemo(() => groupPaletteItems(items), [items]);
  // 扁平下标 → 渲染需要的 (分组, 组内下标)。分组只改结构，不改下标的唯一真相。
  const { section, offsetOf } = useMemo(() => {
    let cursor = 0;
    const offsets = new Map<PaletteGroup, number>();
    for (const s of sections) {
      offsets.set(s.group, cursor);
      cursor += s.items.length;
    }
    const target = sections.find((s) => {
      const start = offsets.get(s.group) ?? 0;
      return highlight >= start && highlight < start + s.items.length;
    });
    return { section: target, offsetOf: offsets };
  }, [sections, highlight]);

  // 高亮行滚进可视区（否则方向键在长列表里「看不见自己在哪」）。
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    // jsdom 没有布局，scrollIntoView 也不存在 —— 可选调用，测试不依赖它。
    active?.scrollIntoView?.({ block: 'nearest' });
  }, [highlight, section?.group]);

  return (
    <div
      className="composer-palette"
      role="listbox"
      aria-label={kind === 'slash' ? '命令补全' : '文件补全'}
      aria-orientation="vertical"
    >
      {items.length === 0 && <div className="composer-palette-empty">{emptyText}</div>}
      <div className="composer-palette-scroll" ref={listRef}>
        {sections.map((s) => {
          const Icon = PALETTE_GROUP_ICONS[s.group];
          const start = offsetOf.get(s.group) ?? 0;
          return (
            <div key={s.group} className="composer-palette-group" role="group" aria-label={s.label}>
              <div className="composer-palette-group-title" aria-hidden="true">
                <Icon size={11} />
                <span>{s.label}</span>
                <span className="composer-palette-group-count">{s.items.length}</span>
              </div>
              {s.items.map((item, i) => {
                const index = start + i;
                return (
                  <button
                    key={`${item.value}:${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === highlight}
                    data-active={index === highlight}
                    className={`composer-palette-item${index === highlight ? ' active' : ''}`}
                    title={item.sublabel}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => onHighlight(index)}
                    onClick={() => onPick(index)}
                  >
                    <span className="composer-palette-label">{item.label}</span>
                    {item.sublabel && <span className="composer-palette-sub">{item.sublabel}</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default React.memo(ComposerPalette);
