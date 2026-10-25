import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@/shared/store/editorStore';
import type { FileNode } from '@/shared/types/file';
import type { AgentCommandEntry, ComposerDocJson } from '@/shared/types/tab';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { createCommandSource, createMentionSource } from '../../paletteSources';
import type { ComposerPaletteSource } from '../../paletteSources';
import { docToPromptText } from '../editorSchema';
import RichComposer from '../RichComposer';

const mkSession = (projectId: string) => WorkspaceSession.of(projectId, null);
const SPACE = mkSession('p1').key;

const COMMANDS: AgentCommandEntry[] = [
  { name: 'tr', description: 'Run tests', source: 'prompt' },
  { name: 'vision-handoff', description: null, source: 'extension' },
];

const TREE: FileNode[] = [
  { name: 'foo.ts', path: 'src/foo.ts', is_dir: false, children: [] },
  { name: 'bar.tsx', path: 'src/bar.tsx', is_dir: false, children: [] },
];

function seedChatTab(doc?: ComposerDocJson) {
  useEditorStore.getState().addTab({
    id: 'tc1',
    scope: { kind: 'workspace', session: mkSession('p1') },
    title: 'Agent Chat',
    data: { kind: 'agent-chat', composerDoc: doc },
  });
}

interface RenderParams {
  sources?: ComposerPaletteSource[];
}

function renderComposer(params: RenderParams = {}): {
  onSend: ReturnType<typeof vi.fn>;
  editor: Editor;
} {
  const onSend = vi.fn();
  let editor: Editor | null = null;
  render(
    <RichComposer
      tabKey={SPACE}
      tabId="tc1"
      onSend={onSend}
      sources={params.sources}
      onReady={(instance) => {
        editor = instance;
      }}
    />,
  );
  if (!editor) throw new Error('editor not created');
  return { onSend, editor };
}

async function typeText(editor: Editor, text: string) {
  await waitFor(() => {
    editor.commands.insertContent(text);
  });
}

async function pressKey(key: string, init: Partial<KeyboardEvent> = {}) {
  fireEvent.keyDown(screen.getByRole('textbox'), { key, ...init });
}

function docOf(editor: Editor): ComposerDocJson {
  return editor.getJSON() as ComposerDocJson;
}

describe('RichComposer × suggestion 弹层（阶段 3 集成，mock 数据源）', () => {
  beforeEach(() => {
    useEditorStore.setState({ tabs: {}, editorLayout: {} });
    seedChatTab();
  });

  it('输入 `/` 弹层出现，Enter 选中 → CommandChip 入文且序列化含 `/tr `；不发送（AC7 等价）', async () => {
    const onPickFile = vi.fn();
    const { onSend, editor } = renderComposer({
      sources: [createCommandSource(COMMANDS), createMentionSource(TREE, onPickFile)],
    });

    await typeText(editor, '/');
    const palette = await screen.findByRole('listbox');
    await pressKey('Enter');

    const content = docOf(editor).content?.[0]?.content;
    expect(content?.some((n) => n.type === 'commandChip')).toBe(true);
    expect(docToPromptText(docOf(editor))).toContain('/tr ');
    // 弹层打开时 Enter 只选中候选，绝不触发发送（10-21 AC7 缺陷形态）。
    expect(onSend).not.toHaveBeenCalled();
    // 选中后弹层关闭（触发段已被 chip 替换）。
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    void palette;
  });

  /**
   * `@` 选中 → FileChip 入文；**没有附件副作用**（B 方案）：请求的 files 是
   * 文档投影（`docToRequestFiles`），此处 Enter 发送时一并验证。
   */
  it('输入 `@` 弹层出现，Enter 选中 → FileChip 入文且 files 由文档投影得出', async () => {
    const { onSend, editor } = renderComposer({
      sources: [
        createMentionSource([
          { name: 'foo.ts', path: 'src/foo.ts', is_dir: false, children: [] },
        ] as FileNode[]),
      ],
    });
    typeText(editor, '@foo');

    const listbox = await screen.findByRole('listbox', { name: '文件补全' });
    fireEvent.click(within(listbox).getAllByRole('option')[0]);

    const dom = screen.getByRole('textbox');
    await waitFor(() => expect(dom).toHaveTextContent(/foo\.ts/));

    await pressKey('Enter');
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith({ promptText: '@src/foo.ts ', files: ['src/foo.ts'] }),
    );
  });

  it('↑↓ 移动高亮，Enter 选中的是高亮项', async () => {
    const onPickFile = vi.fn();
    const { editor } = renderComposer({
      sources: [createCommandSource(COMMANDS), createMentionSource(TREE, onPickFile)],
    });

    await typeText(editor, '@');
    await screen.findByRole('listbox');
    expect(screen.getAllByRole('option')).toHaveLength(2);

    await pressKey('ArrowDown');
    await waitFor(() => expect(screen.getAllByRole('option')[1]).toHaveClass('active'));

    await pressKey('Enter');
    expect(docToPromptText(docOf(editor))).toContain('@src/bar.tsx ');
  });

  it('能力位关闭（无 slash 源）：`/` 不触发弹层，文件源不受门控', async () => {
    const getItems = vi.fn(() => createMentionSource(TREE, vi.fn()).getItems(''));
    const mentionOnly: ComposerPaletteSource = {
      kind: 'mention',
      emptyText: 'No files loaded yet',
      getItems,
    };
    const { editor } = renderComposer({ sources: [mentionOnly] });

    await typeText(editor, '/');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(docOf(editor).content?.[0]?.content?.[0]?.text).toBe('/');
    });

    // 文件源不门控：`@` 照常出弹层，items 被询问。
    await typeText(editor, ' @');
    await screen.findByRole('listbox');
    expect(getItems).toHaveBeenCalled();
  });

  it('Esc 关闭弹层后 Enter 恢复发送', async () => {
    const onPickFile = vi.fn();
    const { onSend, editor } = renderComposer({
      sources: [createCommandSource(COMMANDS), createMentionSource(TREE, onPickFile)],
    });

    await typeText(editor, '/');
    await screen.findByRole('listbox');
    await pressKey('Escape');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());

    await pressKey('Enter');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith({ promptText: '/', files: [] });
  });

  it('弹层候选为空时 Enter 直接发送（10-21 空态契约：只消费 Escape）', async () => {
    const onPickFile = vi.fn();
    const { onSend, editor } = renderComposer({
      sources: [createCommandSource(COMMANDS), createMentionSource(TREE, onPickFile)],
    });

    await typeText(editor, '@zzz-no-hit');
    const palette = await screen.findByRole('listbox');
    expect(within(palette).getByText('No matching files')).toBeInTheDocument();

    await pressKey('Enter');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith({ promptText: '@zzz-no-hit', files: [] });
  });

  it('弹层打开时 Shift+Enter 不选中候选（换行语义归编辑器）', async () => {
    const onPickFile = vi.fn();
    const { editor } = renderComposer({
      sources: [createCommandSource(COMMANDS), createMentionSource(TREE, onPickFile)],
    });

    await typeText(editor, '/');
    await screen.findByRole('listbox');
    await pressKey('Enter', { shiftKey: true });

    expect(docOf(editor).content).toHaveLength(2);
    expect(docOf(editor).content?.[0]?.content?.some((n) => n.type === 'commandChip')).toBe(false);
  });
});
