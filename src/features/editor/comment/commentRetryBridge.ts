/**
 * 失败 chip → 单组重试的**桥接层**（PRD R6.6）。
 *
 * ## 为什么独立成文件
 *
 * `commentView.ts` 承担两件变化理由完全不同的事：**译文如何渲染**（widget 的 DOM 构造）与
 * **失败 chip 如何被点击重试**（DOM 属性 + 模块级注册表 + 事件定位）。前者随视觉设计演进，
 * 后者随交互协议演进。混在一个文件里，改「chip 长什么样」要读懂 400 行渲染代码。
 *
 * ## 为什么用注册表而不是把回调放进 extension
 *
 * widget 的 `toDOM()` 是纯 DOM 构造，拿不到 React 闭包；而把 React 回调塞进 `extensions`
 * 依赖会让扩展身份随每次渲染抖动 → `reconfigure` → 丢掉 lint 等经 `appendConfig` 惰性安装
 * 的扩展（`quality-guidelines.md` 禁止模式 10 / PRD AC16）。
 *
 * ## 为什么按 `EditorView` 索引而不是全局单槽
 *
 * 分屏会同时挂多个编辑器。单槽的语义是「最后挂的那个赢」—— 在 A 窗格点 chip 会重试到
 * B 窗格的组号上，且无任何报错（组号在不同文件里可能都叫 3）。按 view 索引后
 * 回调与触发它的那一个编辑器严格对应。
 *
 * ## 为什么存的是**引用**（`{current}`）而不是视图
 *
 * 编辑器视图由子组件的 ref 回调创建，挂载那一刻还是 `null`。若注册要求传入真实视图，
 * 控制器就得到视图才有值 —— 而视图出现**不保证触发重新渲染**（宿主组件被 `React.memo`
 * 挡住时，props 全稳定就不重渲）。那种情况下 chip 渲染正常、点击**静默无反应**。
 * 存引用后：注册只发生在挂载时（一定发生），命中时再读 `current`（此时一定有值）。
 */
import type { EditorView } from '@codemirror/view';

/**
 * 失败 chip 上的 `data-` 属性名 —— 单组重试（R6.6）的**唯一**定位通道。
 *
 * 值与 {@link CommentDecoration.groupKey} 同源（`CommentGroup.startLine`）。
 * 导出是为了让测试不手抄字符串（手抄会让「改名」静默变成不匹配）。
 */
export const RETRY_GROUP_ATTRIBUTE = 'data-comment-retry-group';

/** 「持有一个 `EditorView` 的引用」而**不是**视图本身 —— 注册时视图可能还不存在。 */
export interface RetryTargetRef {
  readonly current: EditorView | null;
}

/**
 * 单组重试回调的注册表。
 *
 * ## 为什么需要这张表，而不是把回调放进 extension
 *
 * widget 的 `toDOM()` 是**纯 DOM 构造**，拿不到 React 闭包；而把 React 回调塞进
 * `extensions` 依赖会让扩展身份随每次渲染抖动 → `reconfigure` → 丢掉 lint 等经
 * `appendConfig` 惰性安装的扩展（`quality-guidelines.md` 禁止模式 10 / PRD AC16）。
 *
 * ## 为什么按 `EditorView` 索引而不是全局单槽
 *
 * 分屏会同时挂多个编辑器。单槽的语义是「最后挂的那个赢」—— 在 A 窗格点 chip 会重试到
 * B 窗格的组号上，且无任何报错（组号在不同文件里可能都叫 3）。按 view 索引后
 * 回调与触发它的那一个编辑器严格对应。
 *
 * ## 为什么存的是**引用**（`{current}`）而不是视图
 *
 * 编辑器视图由子组件的 ref 回调创建，挂载那一刻还是 `null`。若注册要求传入真实视图，
 * 控制器就得到视图才有值 —— 而视图出现**不保证触发重新渲染**（宿主组件被 `React.memo`
 * 挡住时，props 全稳定就不重渲）。那种情况下 chip 渲染正常、点击**静默无反应**。
 * 存引用后：注册只发生在挂载时（一定发生），命中时再读 `current`（此时一定有值）。
 */
interface RetryRegistration {
  target: RetryTargetRef;
  handler: (groupKey: number) => void;
}

const retryRegistrations = new Set<RetryRegistration>();

/**
 * 注册单组重试回调，返回注销函数（在控制器的 effect cleanup 里调）。
 *
 * `target` 应当是一个**稳定的**引用对象（React `useRef` 的返回值）——
 * 它参与命中判定，换成每次渲染新建的对象会让旧注册永远不再命中。
 */
export function registerCommentRetryHandler(
  target: RetryTargetRef,
  handler: (groupKey: number) => void,
): () => void {
  const registration: RetryRegistration = { target, handler };
  retryRegistrations.add(registration);
  return () => {
    retryRegistrations.delete(registration);
  };
}

/** 找到发起本次事件的那个编辑器对应的回调。 */
export function retryHandlerFor(view: EditorView): ((groupKey: number) => void) | undefined {
  for (const registration of retryRegistrations) {
    if (registration.target.current === view) return registration.handler;
  }
  return undefined;
}

/** 从事件目标向上找失败 chip，返回它声明的组标识。 */
export function retryGroupKeyOf(event: Event): number | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const chip = target.closest(`[${RETRY_GROUP_ATTRIBUTE}]`);
  if (!(chip instanceof HTMLElement)) return null;
  const raw = chip.getAttribute(RETRY_GROUP_ATTRIBUTE);
  if (raw === null) return null;
  const key = Number(raw);
  return Number.isFinite(key) ? key : null;
}

/** 给失败 chip 加可点击标记（纯 DOM 侧的唯一构造点）。 */
export function markChipRetryable(chip: HTMLElement, groupKey: number | undefined): void {
  if (groupKey === undefined) return;
  chip.setAttribute(RETRY_GROUP_ATTRIBUTE, String(groupKey));
  chip.setAttribute('role', 'button');
  chip.title = '点击只重试这一组';
}
