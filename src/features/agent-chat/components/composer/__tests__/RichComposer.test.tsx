import { fireEvent, render, screen } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@/shared/store/editorStore';
import type { ComposerDocJson } from '@/shared/types/tab';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { docToPromptText } from '../editorSchema';
import RichComposer from '../RichComposer';

const mkSession = (projectId: string) => WorkspaceSession.of(projectId, null);
const SPACE = mkSession('p1').key;

function seedChatTab(
  data: { kind: 'agent-chat'; composerDoc?: ComposerDocJson } = {
    kind: 'agent-chat',
  },
) {
  useEditorStore.getState().addTab({
    id: 'tc1',
    scope: { kind: 'workspace', session: mkSession('p1') },
    title: 'Agent Chat',
    data,
  });
}

function composerDocOf(): ComposerDocJson | undefined {
  const tab = useEditorStore.getState().tabs[SPACE]!.tabs.find((t) => t.id === 'tc1')!;
  return tab.data.kind === 'agent-chat' ? tab.data.composerDoc : undefined;
}

/** onReady 在「草稿恢复」之前触发 —— 测试借此在恢复发生前挂 spy / 拿实例。 */
function renderComposer(
  params: {
    legacyInput?: string;
    seed?: Parameters<typeof seedChatTab>[0];
    onReady?: (editor: Editor) => void;
  } = {},
) {
  if (params.seed) seedChatTab(params.seed);
  const onSend = vi.fn();
  let editor: Editor | null = null;
  render(
    <RichComposer
      tabKey={SPACE}
      tabId="tc1"
      legacyInput={params.legacyInput}
      onSend={onSend}
      onReady={(instance) => {
        editor = instance;
        params.onReady?.(instance);
      }}
    />,
  );
  if (!editor) throw new Error('editor not created');
  return { onSend, editor };
}

function pressEnter(init: Partial<KeyboardEvent> = {}) {
  // ProseMirror 可编辑元素带 aria-label → role=textbox；不直接摸 DOM（no-node-access）。
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ...init });
}

describe('RichComposer', () => {
  beforeEach(() => {
    useEditorStore.setState({ tabs: {}, editorLayout: {} });
  });

  it('输入文本写入 tab data（真 store 读回）', () => {
    seedChatTab();
    const { editor } = renderComposer();
    editor.commands.insertContent('hello');

    const content = composerDocOf()?.content?.[0]?.content;
    expect(content?.[0]?.type).toBe('text');
    expect(content?.[0]?.text).toBe('hello');
  });

  it('Enter 发送序列化文本并清空编辑器', () => {
    seedChatTab();
    const { onSend, editor } = renderComposer();
    editor.commands.insertContent('hello');
    pressEnter();

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith({ promptText: 'hello', files: [] });
    expect(editor.isEmpty).toBe(true);
  });

  it('空内容 Enter 不发送也不产生换行', () => {
    seedChatTab();
    const { onSend, editor } = renderComposer();
    pressEnter();

    expect(onSend).not.toHaveBeenCalled();
    expect(editor.isEmpty).toBe(true);
  });

  it('Shift+Enter 换行不发送', () => {
    seedChatTab();
    const { onSend, editor } = renderComposer();
    editor.commands.insertContent('line1');
    pressEnter({ shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(editor.getJSON().content).toHaveLength(2);
  });

  it('IME 组合期 Enter 不进入发送路径', () => {
    seedChatTab();
    const { onSend, editor } = renderComposer();
    editor.commands.insertContent('拼音');
    pressEnter({ isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(editor.isEmpty).toBe(false);
  });

  it('chip 在文档中时 Enter 发送序列化形状 `/name `', () => {
    seedChatTab();
    const { onSend, editor } = renderComposer();
    editor.commands.insertContent('run ');
    editor.commands.insertContent({
      type: 'commandChip',
      attrs: { name: 'tr', source: 'prompt' },
    });
    pressEnter();

    expect(onSend).toHaveBeenCalledWith({ promptText: 'run /tr ', files: [] });
    expect(editor.isEmpty).toBe(true);
  });

  it('草稿恢复走一次 setContent；后续输入不触发 setContent（单向闸门）', () => {
    let setContentSpy: ReturnType<typeof vi.spyOn>;
    const { editor } = renderComposer({
      seed: {
        kind: 'agent-chat',
        composerDoc: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'draft text' }] }],
        },
      },
      // 组件保证 onReady 先于恢复执行 —— spy 在恢复发生前挂上。
      onReady: (instance) => {
        // v3 的 editor.commands 每次访问都重建（getter），spy 必须挂在稳定的
        // rawCommands 上才能拦到调用。
        const rawCommands = (
          instance as unknown as {
            commandManager: { rawCommands: Record<string, (...args: never[]) => unknown> };
          }
        ).commandManager.rawCommands;
        setContentSpy = vi.spyOn(rawCommands, 'setContent');
      },
    });

    expect(editor.getText()).toBe('draft text');
    editor.commands.insertContent(' more');

    expect(setContentSpy!).toHaveBeenCalledTimes(1); // 只有挂载恢复，没有回流
    expect(docToPromptText(composerDocOf()!)).toBe('draft text more');
  });

  it('旧纯文本草稿（legacyInput）按纯文本恢复，不走 HTML 解析', () => {
    seedChatTab();
    const { editor } = renderComposer({ legacyInput: 'line1\n<b>not html</b>' });

    expect(docToPromptText(editor.getJSON() as ComposerDocJson)).toBe('line1\n<b>not html</b>');
  });

  it('composerDoc 存在时优先于 legacyInput', () => {
    seedChatTab({
      kind: 'agent-chat',
      composerDoc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'doc draft' }] }],
      },
    });
    const { editor } = renderComposer({ legacyInput: 'old draft' });

    expect(editor.getText()).toBe('doc draft');
  });
});
