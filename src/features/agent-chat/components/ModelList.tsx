import { useEffect, useRef } from 'react';

import type { ModelInfo } from '@/features/agent/api/agentApi';
import { modelKeyOf } from '@/shared/utils/modelTarget';

import { displayName } from './constants';
import { ModelBadge } from './ModelBadge';

/**
 * 模型下拉里的列表。
 *
 * # 职责边界
 *
 * 只负责「把一串 `ModelInfo` 渲染成可点条目」：高内聚于渲染，低耦合于搜索
 * 逻辑（由 `useModelSearch` 提供）与开关状态（由容器持有）。
 *
 * # 两个关键契约
 *
 * 1. **key 与选中判定必须走 `modelKeyOf`** —— Pi 的 224 条模型只有 194 个唯一
 *    id，裸 id 会重复 key、多行同时高亮。`modelKeyOf` 对无 group 的条目返回
 *    裸 id（**不带**尾部 `|`），与有 group 的 `id|group` 同处一套表示。
 * 2. **`disabled` 是整份列表的可写性** —— 不可写时逐项禁用，而不是渲染一个
 *    点了没反应的列表（PRD R3）。
 */
export interface ModelListProps {
  models: ModelInfo[];
  /**
   * 选中项的组合键（`modelKeyOf`）。除高亮外，**打开列表时会被滚动到视口内**。
   *
   * Pi 实测 165~179 条模型，选中项常在列表深处 —— 只高亮不滚动等于让用户
   * 在 165 条里自己找一遍。
   */
  selectedKey: string | undefined;
  onSelect: (model: ModelInfo) => void;
  /** 列表只供展示（无写通道）时禁用每一项。 */
  disabled?: boolean;
  /**
   * 列表被禁用时的**原因提示**（`disabled` 为真时渲染在列表上方）。
   *
   * 没有它，用户看到的就是「一串灰掉的模型」，无法区分「会话还在建」与
   * 「这个 agent 不能切模型」—— 那是 R3「点了没反应」的变体：
   * 没反应且不知道为什么。
   */
  disabledHint?: string;
  emptyMessage?: string;
}

export function ModelList({
  models,
  selectedKey,
  onSelect,
  disabled = false,
  disabledHint,
  emptyMessage = 'No models available',
}: ModelListProps) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  /**
   * 打开列表时把选中项滚进视口。
   *
   * `block: 'center'` 而不是默认的 `'nearest'`：选中项若恰好在列表边缘，
   * `nearest` 会把它贴在边线上，上下各只露出一条 —— 用户仍然看不清它的
   * 上下文（相邻候选）。居中才有「我在这附近」的空间感。
   *
   * 依赖 `models`：搜索过滤后列表会重建，此时也要重新定位（否则过滤到只剩
   * 一条选中项时，滚动位置还停在上一次的地方）。
   */
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'center' });
  }, [models, selectedKey]);

  if (models.length === 0) {
    return <div className="attach-empty">{emptyMessage}</div>;
  }

  return (
    <>
      {/*
        禁用时必须说明原因：用户看到「一串灰模型」无法区分「会话还在建」
        与「这个 agent 不能切模型」—— 那是 R3 的变体：没反应且不知道为什么。

        必须在 listbox **外面**：`role="listbox"` 只允许 option / group 作为子元素，
        塞一个普通文本 div 进去会被屏幕阅读器整段忽略 —— 那正好是这条提示
        要防的东西（「不知道为什么」）。
      */}
      {disabled && disabledHint ? <div className="attach-empty">{disabledHint}</div> : null}
      {/*
        `role="listbox"` 不能省：下面每个条目是 `role="option"`，而 option 必须归属于
        一个 listbox —— 否则屏幕阅读器读到的就是一串孤立条目，既念不出「共 N 项」，
        也读不到选中态。项目内既有范式：`ActionPalette.tsx:94`。
      */}
      <div role="listbox" aria-label="Models">
        {models.map((m) => {
          // 选中判据**必须**走 `modelKeyOf`，不能是裸 id —— Pi 的 224 条模型只有
          // 194 个唯一 id。用裸 id 时两行会同时报 `aria-selected="true"`，
          // 屏幕阅读器念出两个「已选中」。这与 React key 用同一判据不是巧合：
          // 二者问的是同一个问题「这是不是同一条」。
          const isSelected = selectedKey === modelKeyOf(m);
          return (
            <button
              key={modelKeyOf(m)}
              ref={isSelected ? selectedRef : undefined}
              type="button"
              role="option"
              aria-selected={isSelected}
              className={`param-option${isSelected ? ' selected' : ''}`}
              disabled={disabled}
              onClick={() => onSelect(m)}
            >
              <span className="param-opt-icon">
                <ModelBadge modelId={m.id} modelName={m.name} />
              </span>
              <span className="param-opt-info">
                <span className="param-opt-name">{displayName(m.name)}</span>
                {/*
              这里曾拼 `provider · 200k ctx · free`。三者都不是模型条目的属性：
              provider 已并入 `name`（解析实现如此），上下文大小与免费标记在 ACP 里
              是 `model_config` 配置项，规范要求渲染在模型选择器**附近**而不是挤进
              同一行文本。改由下方 config 区呈现。
            */}
                {(m.group ?? m.description) ? (
                  <span className="param-opt-desc">{m.group ?? m.description}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
