/**
 * 失败 chip → 单组重试的**桥接层**（PRD R6.6）。
 *
 * ## 为什么需要一层桥
 *
 * chip 由 `commentView.ts` 的 widget 生成 —— 那是**纯 DOM 构造**（`WidgetType.toDOM()`），
 * 拿不到 React 闭包；而把 React 回调塞进 `extensions` 依赖会让扩展身份随每次渲染抖动 →
 * CM `reconfigure` → 丢掉 lint 等经 `appendConfig` 惰性安装的扩展
 * （`quality-guidelines.md` 禁止模式 10 / PRD AC16）。
 *
 * 所以两侧各让一步：
 * - 渲染侧只写一个 `data-comment-retry-group` 属性，并在插件 `eventHandlers` 里读回它；
 * - 控制器侧经模块级注册表（`registerCommentRetryHandler`）把回调交给渲染侧。
 * 本文件就是控制器这一侧的唯一接线点。
 *
 * ## 为什么单独成文件（而不是塞在 `useCommentTranslateActions`）
 *
 * 那个 hook 已贴着 `check_component_size` 的 300 行 ratchet 红线。桥接逻辑（注册 /
 * 注销 / 重注册时机）与翻译状态机是两件独立的事，抽出来各自可说清；顺带把红线留出余量。
 */
import type { EditorView } from '@codemirror/view';
import { useEffect } from 'react';

import { registerCommentRetryHandler } from '../comment/commentView';

/**
 * 把失败 chip 的点击接到 `onRetryGroup`。
 *
 * @param editorViewRef 编辑器视图引用（视图由子组件创建，首次渲染时可能还是 `null`）
 * @param onRetryGroup 收到组的 `startLine`（见 `RunCommentTranslationOptions.onlyGroups`）
 *
 * ## 为什么传**引用对象**而不是视图
 *
 * 视图由子组件的 ref 回调创建，挂载那一刻 `editorViewRef.current` 还是 `null`。若复探式地
 * 「有视图才注册」，就得依赖视图出现后重新渲染 —— 而祖先组件被 `React.memo` 挡住时
 * props 全稳定就不重渲，注册就永远不会发生，chip 点击**静默无反应**。
 *
 * 所以注册表存引用（见 `commentView.ts` 的 `RetryTargetRef`），本 effect 只在挂载时跑一次。
 *
 * ## 为什么不带依赖数组
 *
 * `onRetryGroup` 每渲染都是新闭包（它要捕捉最新的 `retryGroup`）。带上它意味着每次渲染
 * 重注册（可接受），但不带依赖数组时 React 会在**每次提交**都跑 effect —— 两者代价相近，
 * 而漏注册的代价是一条静默失效的交互。这里选「每次提交重注册」并与闭包保持同步。
 */
export function useCommentRetryChipBridge(
  editorViewRef: React.MutableRefObject<EditorView | null>,
  onRetryGroup: (groupKey: number) => void,
): void {
  useEffect(() => registerCommentRetryHandler(editorViewRef, onRetryGroup));
}
