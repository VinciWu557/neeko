import { javascriptLanguage } from '@codemirror/lang-javascript';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { commentTranslationField } from '@/features/editor/comment/commentTranslations';
import { commentTranslationView } from '@/features/editor/comment/commentView';
import { MemoryCache } from '@/features/editor/comment/translationCache';
import {
  __setSharedCommentCacheForTests,
  useCommentTranslateActions,
} from '@/features/editor/hooks/useCommentTranslateActions';

// turn 由 createTauriTurn 提供（内部走 IPC）；测试替换掉它。
const runMock = vi.fn();
vi.mock('@/features/editor/translation/tauriTurn', () => ({
  createTauriTurn: () => ({ run: runMock }),
}));

/**
 * 注释翻译动作 hook（方案 A 入口）。
 *
 * 关键断言：译文只进 `StateField`（decoration），**文档字节零改动**（AC15）。
 */

function makeView(doc: string) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc,
      // 真实挂上渲染扩展：单组重试的点击路径要过 `WidgetType.toDOM` + 插件的
      // `eventHandlers`，只挂 field 会让 chip 根本不存在（用例变成空转）。
      extensions: [javascriptLanguage, commentTranslationView()],
    }),
    parent,
  });
}

/**
 * 用 `initialProps` 形式渲染，`rerender({ content })` 才真的能改 `content` prop。
 *
 * 首版写成 `renderHook(() => ...)` 闭包固定 doc —— `rerender(newProps)` 的参数被静默忽略，
 * 「内容变化清空译文」用例因此测的是空转（假绿）。
 */
function setup(doc: string, extra: Partial<Parameters<typeof useCommentTranslateActions>[0]> = {}) {
  const view = makeView(doc);
  const ref = { current: view };
  const rendered = renderHook(
    (props: { content: string }) =>
      useCommentTranslateActions({
        filePath: 'a.ts',
        projectId: 'p1',
        editorViewRef: ref,
        agentId: 'opencode',
        content: props.content,
        ...extra,
      }),
    { initialProps: { content: doc } },
  );
  return { view, ref, rendered };
}

describe('useCommentTranslateActions', () => {
  beforeEach(() => {
    runMock.mockReset();
    __setSharedCommentCacheForTests(new MemoryCache());
  });

  it('should report supported for a language with comment semantics', () => {
    const { rendered } = setup('// hi\nconst a = 1;');
    expect(rendered.result.current.supported).toBe(true);
  });

  it('should report unsupported for markdown so the entry is hidden', () => {
    const { rendered } = setup('# title', { filePath: 'a.md' } as never);
    expect(rendered.result.current.supported).toBe(false);
  });

  it('should not modify the document when translating (AC15)', async () => {
    const doc = '// Replace the call:\n//   const x = f(a);\n// with cache.\nconst a = 1;';
    runMock.mockResolvedValue(JSON.stringify(['替换调用：', '改为缓存。']));

    const { view, rendered } = setup(doc);
    await act(async () => {
      await rendered.result.current.start();
    });

    // 文档字节零改动
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('should push translations into the StateField (decoration layer)', async () => {
    runMock.mockResolvedValue(JSON.stringify(['替换调用：', '改为缓存。']));
    const { view, rendered } = setup(
      '// Replace the call:\n//   const x = f(a);\n// with cache.\n',
    );

    await act(async () => {
      await rendered.result.current.start();
    });

    const field = view.state.field(commentTranslationField, false);
    expect(field?.entries.length).toBeGreaterThan(0);
    expect(field?.mode).toBe('below');
  });

  it('should never send code segments to the model (U2)', async () => {
    runMock.mockResolvedValue(JSON.stringify(['替换调用：']));
    const { rendered } = setup('// Replace the call:\n//   const x = f(a);\n// with cache.\n');

    await act(async () => {
      await rendered.result.current.start();
    });

    const prompts = runMock.mock.calls.map((call) => String(call[0])).join('\n');
    expect(prompts).not.toContain('const x = f(a)');
  });

  it('should change the display mode without re-running the model', async () => {
    runMock.mockResolvedValue(JSON.stringify(['译文']));
    const { view, rendered } = setup('// some prose here\n');

    await act(async () => {
      await rendered.result.current.start();
    });
    const callsAfterFirst = runMock.mock.calls.length;

    await act(async () => {
      rendered.result.current.setMode('off');
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.state.field(commentTranslationField, false)?.mode).toBe('off');
    });
    // 切模式不重新请求
    expect(runMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('should stop an in-flight job by aborting the signal', async () => {
    runMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(JSON.stringify(['x'])), 50);
        }),
    );
    const { rendered } = setup('// some prose here\n');

    let startPromise: Promise<void> | undefined;
    act(() => {
      startPromise = rendered.result.current.start();
    });
    act(() => {
      rendered.result.current.stop();
    });
    await act(async () => {
      await startPromise;
    });

    await waitFor(() => {
      expect(rendered.result.current.state.running).toBe(false);
    });
  });

  it('should clear translations when the document content changes', async () => {
    runMock.mockResolvedValue(JSON.stringify(['译文']));
    const doc = '// some prose here\n';
    const { view, rendered, ref } = setup(doc);

    await act(async () => {
      await rendered.result.current.start();
    });
    expect(view.state.field(commentTranslationField, false)?.entries.length).toBeGreaterThan(0);

    // 模拟文档被编辑 → 必须把**新内容**作为 prop 重新渲染，
    // 否则 hook 看不到 `content` 变化（首版只调 `rerender()` 无参数 = 空转，用例假绿）。
    const edited = `${doc}const b = 2;`;
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'const b = 2;' } });
    rendered.rerender({ content: edited });

    await waitFor(() => {
      const field = ref.current?.state.field(commentTranslationField, false);
      expect(field?.entries ?? []).toHaveLength(0);
    });
  });

  it('should surface the code-segment count in state (U2 可观测性)', async () => {
    runMock.mockResolvedValue(JSON.stringify(['替换调用：', '改为缓存。']));
    // 两行**连续**代码合并成**一个** code 段（这是设计意图：重建时要整体回写）
    const { rendered } = setup(
      '// Replace the call:\n//   const x = f(a);\n//   if (x) { return; }\n// with cache.\n',
    );

    await act(async () => {
      await rendered.result.current.start();
    });

    // 统计单位是「段」而非「行」——两行连续代码 = 1 段
    expect(rendered.result.current.state.codeSegments).toBe(1);
  });

  it('should not start when unsupported', async () => {
    const { rendered } = setup('# title', { filePath: 'a.md' } as never);
    await act(async () => {
      await rendered.result.current.start();
    });
    expect(runMock).not.toHaveBeenCalled();
  });

  it('should keep running=false after a turn failure (no stuck spinner)', async () => {
    runMock.mockRejectedValue(new Error('agent crashed'));
    const { rendered } = setup('// some prose here\n');

    await act(async () => {
      await rendered.result.current.start();
    });

    await waitFor(() => {
      expect(rendered.result.current.state.running).toBe(false);
    });
  });
});

describe('useCommentTranslateActions / 单组重试端到端（R6.6）', () => {
  // 与主 describe 同款清理：不清共享缓存会让「重试真的发了请求」变成缓存命中（假绿）
  beforeEach(() => {
    runMock.mockReset();
    __setSharedCommentCacheForTests(new MemoryCache());
  });

  /**
   * 完整链路：**点击真实 chip DOM** → 插件 `eventHandlers` → 注册表 → hook 的 `retryGroup`
   * → 控制器 `onlyGroups` + `previousEntries` 合并 → StateField。
   *
   * 为什么不直接调 `retryGroup(3)`：那样只测到「函数能算对」，测不到「chip 与回调接通」。
   * 这一段是本次需求的核心交互，任何一环断掉（chip 无 `data-` 属性 / 插件没挂
   * `eventHandlers` / hook 没注册 / `ignoreEvent` 挡住事件）都表现为**点了没反应**，
   * 而编译、类型、渲染全绿。
   */
  const DOC =
    '// first prose here\nconst a = 1;\n// the {0} placeholder must survive\nconst b = 2;\n';

  /** 第二段丢占位符 → 校验失败（第一段正常译）。 */
  const failingScript = async (prompt: string): Promise<string> => {
    const texts = String(prompt)
      .split('\n')
      .filter((line) => /^\[\d+\] /.test(line))
      .map((line) => line.replace(/^\[\d+\] /, ''));
    return JSON.stringify(
      texts.map((text) => (text.includes('{0}') ? '丢了占位符' : `译:${text}`)),
    );
  };

  it('should retry only the clicked group and keep the other group translation', async () => {
    runMock.mockImplementation(failingScript);
    const { view, rendered } = setup(DOC);

    await act(async () => {
      await rendered.result.current.start();
    });

    const before = view.state.field(commentTranslationField, false)?.entries ?? [];
    const firstBefore = before.find((entry) => entry.groupKey === 1);
    // 前置断言：真的产出了「一组成功 + 一组失败」，否则下面的点击/合并断言是空转
    expect(before).toHaveLength(2);
    expect(firstBefore?.reason).toBeUndefined();
    expect(before.find((entry) => entry.groupKey === 3)?.reason).toBeTruthy();

    // 第二轮：模型这次能译好（模拟用户重试后成功）
    runMock.mockClear();
    runMock.mockImplementation(async (prompt: string) => {
      const texts = String(prompt)
        .split('\n')
        .filter((line) => /^\[\d+\] /.test(line))
        .map((line) => line.replace(/^\[\d+\] /, ''));
      return JSON.stringify(texts.map((text) => `译:${text}`));
    });

    const chip = view.dom.querySelector('.cm-comment-translation__reason');
    expect(chip).not.toBeNull();

    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // 点击触发的是 async 流程（hook 内部 void 掉 promise），等它跑完
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // ① 只请求被重试组
    const prompt = runMock.mock.calls.map((call) => String(call[0])).join('\n');
    expect(runMock.mock.calls.length).toBeGreaterThan(0);
    expect(prompt).toContain('the {0} placeholder must survive');
    expect(prompt).not.toContain('first prose here');

    // ② 合并语义：第一组译文仍在，第二组已修好
    const after = view.state.field(commentTranslationField, false)?.entries ?? [];
    expect(after).toHaveLength(2);
    expect(after.find((entry) => entry.groupKey === 1)?.text).toBe(firstBefore?.text);
    expect(after.filter((entry) => entry.groupKey === 3)).toHaveLength(1);
    expect(after.find((entry) => entry.groupKey === 3)?.reason).toBeUndefined();
  });

  it('should keep the whole-file retry (toolbar button) behaviour separate', async () => {
    runMock.mockImplementation(failingScript);
    const { view, rendered } = setup(DOC);
    await act(async () => {
      await rendered.result.current.start();
    });

    runMock.mockClear();
    runMock.mockImplementation(async (prompt: string) => {
      const texts = String(prompt)
        .split('\n')
        .filter((line) => /^\[\d+\] /.test(line))
        .map((line) => line.replace(/^\[\d+\] /, ''));
      return JSON.stringify(texts.map((text) => `译:${text}`));
    });
    // 清空共享缓存：不清的话第一组的成功译文会命中缓存、根本不再请求，
    // 「整文件粒度」与「单组粒度」的差别就被缓存掩盖了（假绿）。
    __setSharedCommentCacheForTests(new MemoryCache());

    await act(async () => {
      await rendered.result.current.retryFailed();
    });

    // 整文件重试会请求**两组** —— 与单组重试的粒度不同
    const prompt = runMock.mock.calls.map((call) => String(call[0])).join('\n');
    expect(prompt).toContain('first prose here');
    expect(prompt).toContain('the {0} placeholder must survive');
    const after = view.state.field(commentTranslationField, false)?.entries ?? [];
    expect(after.every((entry) => entry.reason === undefined)).toBe(true);
  });
});

describe('useCommentTranslateActions / 视图晚绑定（注册表存引用而不是视图）', () => {
  beforeEach(() => {
    runMock.mockReset();
    __setSharedCommentCacheForTests(new MemoryCache());
  });

  /**
   * 时间顺序上的坑：控制器在**父组件**里挂载时，`editorViewRef.current` 还是 `null`
   * —— 视图由子组件的 ref 回调创建。若「有视图才注册」，就得依赖视图出现后重新渲染；
   * 而祖先被 `React.memo` 挡住（props 全稳定）时不会重渲，注册永远不会发生，
   * chip 点击**静默无反应**（编译 / 类型 / 渲染全绿）。
   *
   * 所以注册表存的是**引用对象**，命中时才读 `current`。本用例先渲染（此时 ref 为 null），
   * 再挂视图、**不重渲**就直接点击 chip。
   */
  it('should still retry when the editor view is attached after mount without a re-render', async () => {
    const doc =
      '// first prose here\nconst a = 1;\n// the {0} placeholder must survive\nconst b = 2;\n';
    runMock.mockImplementation(async (prompt: string) => {
      const texts = String(prompt)
        .split('\n')
        .filter((line) => /^\[\d+\] /.test(line))
        .map((line) => line.replace(/^\[\d+\] /, ''));
      return JSON.stringify(
        texts.map((text) => (text.includes('{0}') ? '丢了占位符' : `译:${text}`)),
      );
    });

    const ref: { current: EditorView | null } = { current: null };
    const rendered = renderHook(() =>
      useCommentTranslateActions({
        filePath: 'a.ts',
        projectId: 'p1',
        editorViewRef: ref,
        agentId: 'opencode',
        content: doc,
      }),
    );

    // 挂载后才创建视图（模拟子组件的 ref 回调），且**不触发重渲**
    const view = makeView(doc);
    ref.current = view;

    await act(async () => {
      await rendered.result.current.start();
    });
    expect(view.state.field(commentTranslationField, false)?.entries).toHaveLength(2);

    runMock.mockClear();
    runMock.mockImplementation(async (prompt: string) => {
      const texts = String(prompt)
        .split('\n')
        .filter((line) => /^\[\d+\] /.test(line))
        .map((line) => line.replace(/^\[\d+\] /, ''));
      return JSON.stringify(texts.map((text) => `译:${text}`));
    });

    const chip = view.dom.querySelector('.cm-comment-translation__reason');
    expect(chip).not.toBeNull();
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(runMock.mock.calls.length).toBeGreaterThan(0);
    const after = view.state.field(commentTranslationField, false)?.entries ?? [];
    expect(after.find((entry) => entry.groupKey === 3)?.reason).toBeUndefined();
  });
});
