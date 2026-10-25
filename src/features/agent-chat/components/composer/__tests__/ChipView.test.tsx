import { fireEvent, render, screen } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@/shared/store/editorStore';
import type { ComposerDocJson } from '@/shared/types/tab';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import RichComposer from '../RichComposer';

const mkSession = (projectId: string) => WorkspaceSession.of(projectId, null);
const SPACE = mkSession('p1').key;

const para = (...content: unknown[]): ComposerDocJson => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: content as ComposerDocJson['content'] }],
});

function seedComposerDoc(doc: ComposerDocJson | undefined) {
  useEditorStore.getState().addTab({
    id: 'tc1',
    scope: { kind: 'workspace', session: mkSession('p1') },
    title: 'Agent Chat',
    data: { kind: 'agent-chat', composerDoc: doc },
  });
}

function renderComposer(): { editor: Editor } {
  let editor: Editor | null = null;
  render(
    <RichComposer
      tabKey={SPACE}
      tabId="tc1"
      onSend={vi.fn()}
      onReady={(instance) => {
        editor = instance;
      }}
    />,
  );
  if (!editor) throw new Error('editor not created');
  return { editor };
}

describe('ChipView — chip 渲染与整块删除（R1）', () => {
  beforeEach(() => {
    useEditorStore.setState({ tabs: {}, editorLayout: {} });
  });

  it('命令 chip 渲染图标 pill：命令名 + 来源配色标记（data-chip-source）', () => {
    seedComposerDoc(para({ type: 'commandChip', attrs: { name: 'tr', source: 'prompt' } }));
    renderComposer();

    expect(screen.getByText('/tr')).toBeInTheDocument();
    const chip = screen.getByTitle('/tr');
    expect(chip).toHaveAttribute('data-chip-source', 'prompt');
    // chip 内有图标（R1：镜像架构下不可能的内嵌图标）。
    // eslint-disable-next-line testing-library/no-node-access -- chip 是 ProseMirror node view 的 DOM，非 React 可查询面
    expect(chip.querySelector('svg')).not.toBeNull();
  });

  it('skill / extension 来源落入各自的 data-chip-source（类型化配色挂钩）', () => {
    seedComposerDoc(
      para(
        { type: 'commandChip', attrs: { name: 'a', source: 'skill' } },
        { type: 'commandChip', attrs: { name: 'b', source: 'extension' } },
        { type: 'commandChip', attrs: { name: 'c' } },
      ),
    );
    renderComposer();

    expect(screen.getByTitle('/a')).toHaveAttribute('data-chip-source', 'skill');
    expect(screen.getByTitle('/b')).toHaveAttribute('data-chip-source', 'extension');
    // 未知来源：不写 data-chip-source，CSS 落到默认蓝。
    expect(screen.getByTitle('/c')).not.toHaveAttribute('data-chip-source');
  });

  it('文件 chip：文件名 + title 显示完整路径', () => {
    seedComposerDoc(
      para({
        type: 'fileChip',
        attrs: { path: 'src/features/agent-chat/index.ts', name: 'index.ts' },
      }),
    );
    renderComposer();

    expect(screen.getByText('index.ts')).toBeInTheDocument();
    const chip = screen.getByTitle('src/features/agent-chat/index.ts');
    // eslint-disable-next-line testing-library/no-node-access -- 同上，node view DOM
    expect(chip.querySelector('svg')).not.toBeNull();
  });

  it('chip 后按 Backspace 整块消失，无 `/` 残留（deleteTriggerWithBackspace）', () => {
    seedComposerDoc(undefined);
    const { editor } = renderComposer();

    editor.commands.insertContent({
      type: 'commandChip',
      attrs: { name: 'tr', source: 'prompt' },
    });
    expect(editor.getJSON().content?.[0]?.content).toHaveLength(1);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Backspace' });

    // 整块删：文档空、无触发符文本残留 —— 变异验证：去掉
    // deleteTriggerWithBackspace 后 mention 会把 `/` 以文本形式留下，本用例红。
    expect(editor.getText()).toBe('');
    expect(editor.getJSON().content?.[0]?.content).toBeUndefined();
  });
});
