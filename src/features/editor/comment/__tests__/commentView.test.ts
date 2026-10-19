import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { setCommentTranslations } from '../commentTranslations';
import {
  commentTranslationView,
  createBelowWidgetForTest,
  registerCommentRetryHandler,
  RETRY_GROUP_ATTRIBUTE,
  toEntry,
} from '../commentView';

/**
 * 渲染层测试（jsdom）：验证 widget 真的生成 DOM、文本正确、失败 chip 可见。
 *
 * 裁剪与模式逻辑在 `commentDecorations.test.ts`（node 环境，纯函数）；
 * 这里测「规格 → DOM」这一步，以及扩展能在真实 `EditorView` 上挂载。
 *
 * **必须有一条 below 模式的真实 EditorView 用例**：block 装饰的来源（`StateField`）
 * 曾是 `ViewPlugin`，CM 6.43.11 对此直接抛
 * `RangeError: Block decorations may not be specified via plugins`。
 * 只测 `createBelowWidgetForTest().toDOM()` 是绕开装配的假绿 —— 那条路径永远不经过 CM。
 */

function makeView(doc: string): EditorView {
  const state = EditorState.create({ doc, extensions: [commentTranslationView()] });
  // EditorView 需要真实 DOM 容器
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({ state, parent });
}

describe('commentView / widget DOM 生成', () => {
  it('should build a below widget whose DOM carries every translated line', () => {
    // 这条只测 **widget 产物**（逐行成块、文本正确），不测「block 装饰能否挂上编辑器」——
    // 后者由下面的 `below 模式（真实 EditorView）` 用例负责。两者是两件事：
    // 本用例即使装饰装配整体坏掉也会绿，所以不能作为 below 模式的唯一护栏。
    const widget = createBelowWidgetForTest('第一行\n第二行');
    const dom = widget.toDOM();
    expect(dom.className).toContain('cm-comment-translation--below');
    expect(dom.querySelectorAll('.cm-comment-translation__line')).toHaveLength(2);
    expect(dom).toHaveTextContent(/第一行/);
    expect(dom).toHaveTextContent(/第二行/);
  });

  it('should keep the below widget stable across identical payloads (eq)', () => {
    const a = createBelowWidgetForTest('同样译文');
    const b = createBelowWidgetForTest('同样译文');
    // eq 为 true 时 CM 复用 DOM，避免每次重算都重建节点
    expect(a.eq(b)).toBe(true);
  });

  it('should render a failure chip instead of text when a reason is present', () => {
    const widget = createBelowWidgetForTest('', 'placeholder lost');
    const dom = widget.toDOM();
    const chip = dom.querySelector('.cm-comment-translation__reason');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('placeholder lost');
    // 失败时不显示译文行
    expect(dom.querySelectorAll('.cm-comment-translation__line')).toHaveLength(0);
  });

  it('should render an inline widget with an arrow prefix', () => {
    const view = makeView('// hello world');
    view.dispatch({
      effects: setCommentTranslations.of({
        mode: 'inline',
        entries: [toEntry(0, 14, '你好')],
      }),
    });

    const inline = view.dom.querySelector('.cm-comment-translation--inline');
    expect(inline).not.toBeNull();
    expect(inline?.textContent).toBe('→ 你好');
    view.destroy();
  });

  it('should render a hover anchor carrying the translation as a title', () => {
    const view = makeView('// hello world');
    view.dispatch({
      effects: setCommentTranslations.of({
        mode: 'hover',
        entries: [toEntry(0, 14, '你好')],
      }),
    });

    const anchor = view.dom.querySelector('.cm-comment-translation__hover-anchor');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('title')).toBe('你好');
    view.destroy();
  });

  it('should render nothing in off mode', () => {
    const view = makeView('// hello world');
    view.dispatch({
      effects: setCommentTranslations.of({
        mode: 'off',
        entries: [toEntry(0, 14, '你好')],
      }),
    });

    expect(view.dom.querySelector('.cm-comment-translation')).toBeNull();
    view.destroy();
  });

  it('should clear the inline widget when translations are replaced with an empty list', () => {
    const view = makeView('// hello world');
    view.dispatch({
      effects: setCommentTranslations.of({ mode: 'inline', entries: [toEntry(0, 14, '你好')] }),
    });
    expect(view.dom.querySelector('.cm-comment-translation--inline')).not.toBeNull();

    view.dispatch({ effects: setCommentTranslations.of({ mode: 'inline', entries: [] }) });
    expect(view.dom.querySelector('.cm-comment-translation--inline')).toBeNull();
    view.destroy();
  });

  it('should not modify the document when rendering translations (AC15)', () => {
    const doc = '// hello world\nconst a = 1;';
    const view = makeView(doc);
    view.dispatch({
      effects: setCommentTranslations.of({ mode: 'inline', entries: [toEntry(0, 14, '你好')] }),
    });

    // 译文只存在于渲染层，文档字节零改动
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });
});

describe('commentView / below 模式（真实 EditorView）', () => {
  /**
   * 修复前的红：block 装饰由 `ViewPlugin` 提供 → CM 6.43.11 在 dispatch 内抛
   * `RangeError: Block decorations may not be specified via plugins`。
   * 生产里这个异常被控制器 catch 吞成 console.error，用户看到的是「什么都没发生」。
   */
  it('should not throw when dispatching a below payload (block decorations come from a StateField)', () => {
    const view = makeView('// hello world\nconst a = 1;\n');

    expect(() =>
      view.dispatch({
        effects: setCommentTranslations.of({
          mode: 'below',
          entries: [toEntry(0, 14, '你好')],
        }),
      }),
    ).not.toThrow();

    view.destroy();
  });

  it('should render the below block widget in a real EditorView', () => {
    const view = makeView('// hello world\nconst a = 1;\n');
    view.dispatch({
      effects: setCommentTranslations.of({
        mode: 'below',
        entries: [toEntry(0, 14, '第一行\n第二行')],
      }),
    });

    const blocks = view.dom.querySelectorAll('.cm-comment-translation--below');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].querySelectorAll('.cm-comment-translation__line')).toHaveLength(2);
    expect(blocks[0]).toHaveTextContent(/第一行/);
    view.destroy();
  });

  it('should clear below blocks when the payload is emptied', () => {
    const view = makeView('// hello world\nconst a = 1;\n');
    view.dispatch({
      effects: setCommentTranslations.of({ mode: 'below', entries: [toEntry(0, 14, '你好')] }),
    });
    expect(view.dom.querySelectorAll('.cm-comment-translation--below')).toHaveLength(1);

    view.dispatch({ effects: setCommentTranslations.of({ mode: 'below', entries: [] }) });
    expect(view.dom.querySelectorAll('.cm-comment-translation--below')).toHaveLength(0);
    view.destroy();
  });

  it('should keep the block widget alive across a doc change (position mapping)', () => {
    const view = makeView('// hello world\nconst a = 1;\n');
    view.dispatch({
      effects: setCommentTranslations.of({ mode: 'below', entries: [toEntry(0, 14, '你好')] }),
    });

    // 行首插入一个字符：block 装饰应映射位置后继续存在，而不是被丢弃/抛错
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    expect(view.dom.querySelectorAll('.cm-comment-translation--below')).toHaveLength(1);
    view.destroy();
  });

  it('should not render below blocks in inline/hover modes (only the plugin-side kinds are drawn)', () => {
    for (const mode of ['inline', 'hover'] as const) {
      const view = makeView('// hello world\nconst a = 1;\n');
      view.dispatch({
        effects: setCommentTranslations.of({ mode, entries: [toEntry(0, 14, '你好')] }),
      });
      expect(view.dom.querySelectorAll('.cm-comment-translation--below')).toHaveLength(0);
      view.destroy();
    }
  });
});

describe('commentView / toEntry 构造', () => {
  it('should omit the reason key when there is no failure', () => {
    const entry = toEntry(0, 10, '译文');
    expect(Object.prototype.hasOwnProperty.call(entry, 'reason')).toBe(false);
  });

  it('should include the reason when provided', () => {
    const entry = toEntry(0, 10, '', 'code span altered');
    expect(entry.reason).toBe('code span altered');
  });
});

describe('commentView / 失败 chip 的单组重试（R6.6）', () => {
  /**
   * chip 是**纯 DOM** 产物，拿不到 React 闭包；回调经模块级注册表
   * （`registerCommentRetryHandler`）到达。所以两侧都要锁：
   * ① chip DOM 上带可点击标记（不带 = 点击无处可定位）；
   * ② 点击真的回调，且组标识正确（回调不通 = 交互静默失效）。
   *
   * 用**真实 `EditorView` + 真实 `MouseEvent`**：`domEventHandlers` 的分发路径
   * 依赖 CM 的 `eventBelongsToEditor` + `ignoreEvent` 判定，单元级调用 handler
   * 函数无法覆盖那两处（`ignoreEvent` 返回 true 会让事件被静默丢弃，全绿）。
   */
  it('should mark the failure chip with the retry group attribute', () => {
    const widget = createBelowWidgetForTest('', 'placeholder lost', 7);
    const dom = widget.toDOM();
    const chip = dom.querySelector('.cm-comment-translation__reason');
    expect(chip?.getAttribute(RETRY_GROUP_ATTRIBUTE)).toBe('7');
    expect(chip?.getAttribute('role')).toBe('button');
  });

  it('should not mark the chip when the group key is unknown', () => {
    const widget = createBelowWidgetForTest('', 'placeholder lost');
    const dom = widget.toDOM();
    // 没有组标识时不能带 `data-` 属性（否则点击会带着 undefined 回调出去）
    expect(dom.querySelector(`[${RETRY_GROUP_ATTRIBUTE}]`)).toBeNull();
  });

  it('should dispatch the group key to the registered handler on chip click', () => {
    const view = makeView('// hello world\nconst a = 1;\n');
    const calls: number[] = [];
    const unregister = registerCommentRetryHandler({ current: view }, (key) => calls.push(key));
    try {
      view.dispatch({
        effects: setCommentTranslations.of({
          mode: 'below',
          entries: [toEntry(0, 14, '', 'placeholder lost', 3)],
        }),
      });

      const chip = view.dom.querySelector('.cm-comment-translation__reason');
      expect(chip).not.toBeNull();
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(calls).toEqual([3]);
    } finally {
      unregister();
      view.destroy();
    }
  });

  it('should route the click to the right editor when two views are mounted', () => {
    // 分屏会同时挂多个编辑器；单槽注册表的语义是「最后挂的赢」，
    // 在 A 窗格点 chip 会重试到 B 窗格的组号上（组号在不同文件里可能都叫 3）。
    const viewA = makeView('// a comment\nconst a = 1;\n');
    const viewB = makeView('// b comment\nconst b = 1;\n');
    const callsA: number[] = [];
    const callsB: number[] = [];
    const unA = registerCommentRetryHandler({ current: viewA }, (key) => callsA.push(key));
    const unB = registerCommentRetryHandler({ current: viewB }, (key) => callsB.push(key));
    try {
      for (const view of [viewA, viewB]) {
        view.dispatch({
          effects: setCommentTranslations.of({
            mode: 'below',
            entries: [toEntry(0, 10, '', 'boom', 9)],
          }),
        });
      }

      viewA.dom
        .querySelector('.cm-comment-translation__reason')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(callsA).toEqual([9]);
      expect(callsB).toEqual([]);
    } finally {
      unA();
      unB();
      viewA.destroy();
      viewB.destroy();
    }
  });

  it('should stop calling the handler after it is unregistered', () => {
    const view = makeView('// hello world\nconst a = 1;\n');
    const calls: number[] = [];
    const unregister = registerCommentRetryHandler({ current: view }, (key) => calls.push(key));
    unregister();

    view.dispatch({
      effects: setCommentTranslations.of({
        mode: 'below',
        entries: [toEntry(0, 14, '', 'boom', 3)],
      }),
    });
    view.dom
      .querySelector('.cm-comment-translation__reason')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(calls).toEqual([]);
    view.destroy();
  });

  it('should not intercept clicks when no handler is registered', () => {
    // 纯渲染场景（无控制器）：chip 仍显示，但事件不被吞掉
    const view = makeView('// hello world\nconst a = 1;\n');
    view.dispatch({
      effects: setCommentTranslations.of({
        mode: 'below',
        entries: [toEntry(0, 14, '', 'boom', 3)],
      }),
    });
    const chip = view.dom.querySelector('.cm-comment-translation__reason')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    chip.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    view.destroy();
  });

  it('should mark the inline failure widget as retryable too', () => {
    const view = makeView('// hello world\nconst a = 1;\n');
    view.dispatch({
      effects: setCommentTranslations.of({
        mode: 'inline',
        entries: [toEntry(0, 14, '', 'boom', 5)],
      }),
    });
    const inline = view.dom.querySelector('.cm-comment-translation--inline');
    expect(inline?.getAttribute(RETRY_GROUP_ATTRIBUTE)).toBe('5');
    view.destroy();
  });
});

describe('commentView / 行内模式的 chip 点击（`ignoreEvent` 的硬约束）', () => {
  /**
   * CM 的 `eventBelongsToEditor` 会沿事件目标向上找 widget tile，只要任一 tile 的
   * `ignoreEvent(event)` 返回 true，**整个事件被丢弃**，插件的 `eventHandlers` 收不到。
   *
   * 所以 `InlineWidget.ignoreEvent` 必须返回 `false`。这条用真实点击锁住：
   * 把返回值改成 `true` 时本用例必须变红（否则那段注释就是一句无约束的断言）。
   */
  it('should dispatch the group key when the inline failure widget is clicked', () => {
    const view = makeView('// hello world\nconst a = 1;\n');
    const calls: number[] = [];
    const unregister = registerCommentRetryHandler({ current: view }, (key) => calls.push(key));
    try {
      view.dispatch({
        effects: setCommentTranslations.of({
          mode: 'inline',
          entries: [toEntry(0, 14, '', 'boom', 5)],
        }),
      });

      const inline = view.dom.querySelector('.cm-comment-translation--inline');
      expect(inline).not.toBeNull();
      inline!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(calls).toEqual([5]);
    } finally {
      unregister();
      view.destroy();
    }
  });
});

describe('失败 chip / 按类型分流', () => {
  /**
   * 这条是本次改动的核心契约：两类失败的用户动作不同。
   *
   * validation（译文没过校验）→ 保留可点击的 ⚠ 原因，点一下只重试这一组。
   * transport（断网 / Agent 崩溃 / 超时）→ 只说「翻译失败」，不挂重试：
   *   单组重试对全局故障毫无意义，挂上去只会让人点了没反应。
   */
  it('should render a retryable chip for validation failures', () => {
    const dom = createBelowWidgetForTest(
      '',
      'placeholder lost',
      7,
      'validation',
    ).toDOM() as HTMLElement;
    const chip = dom.querySelector('.cm-comment-translation__reason');

    expect(chip?.textContent).toContain('placeholder lost');
    expect(chip?.hasAttribute(RETRY_GROUP_ATTRIBUTE)).toBe(true);
  });

  it('should render a non-retryable label for transport failures', () => {
    const dom = createBelowWidgetForTest(
      '',
      'agent exited with code 1',
      7,
      'transport',
    ).toDOM() as HTMLElement;
    const chip = dom.querySelector('.cm-comment-translation__reason');

    expect(chip?.textContent).toBe('翻译失败');
    expect(chip?.getAttribute('title')).toContain('agent exited');
    // 关键：没有可重试的组 → 不得挂点击属性
    expect(chip?.hasAttribute(RETRY_GROUP_ATTRIBUTE)).toBe(false);
  });
});
