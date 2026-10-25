import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@/shared/store/editorStore';
import type { FileNode } from '@/shared/types/file';
import type { AgentCommandEntry } from '@/shared/types/tab';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import ChatComposer from '../ChatComposer';
import { createCommandSource, createMentionSource } from '../paletteSources';
import type { ComposerPaletteSource } from '../paletteSources';

/**
 * ChatComposer × 补全弹层的集成测试（富文本 composer 形态）。
 *
 * # 与 paletteTrigger/suggestionWiring 的分工
 *
 * 触发/过滤/插入的判据细节在 `composer/__tests__/RichComposerSuggestions.test.tsx`
 * （`/` 触发、能力位门控、↑↓ 移动、Enter 选中、Esc 恢复发送）。本文件从
 * **ChatComposer 这一层**钉住三件只有接线才能暴露的事：
 *
 * 1. composer 真的把 editor 的序列化文本交给 `onSend`（chip → `/name `）
 * 2. 发送按钮的 disabled 由**编辑器空内容**派生（不是某个 state 副本）
 * 3. 附件 chips 区与 composer 共存（AC10 零回归）
 *
 * 双击发（AC7）、IME（AC8）在 RichComposer 层已钉住 —— 那里才是键盘真正落地
 * 的地方，在 ChatComposer 层重复一遍只会掩盖真实归属。
 */

const COMMANDS: AgentCommandEntry[] = [
  { name: 'trellis-continue', description: 'Resume work on the current task', source: 'prompt' },
  { name: 'trellis-start', description: 'Start a Trellis task session', source: 'prompt' },
];

const FILES: FileNode[] = [
  { name: 'App.tsx', path: 'src/app/App.tsx', is_dir: false, children: [] },
  {
    name: 'agent-chat',
    path: 'src/features/agent-chat',
    is_dir: true,
    children: [
      {
        name: 'ChatComposer.tsx',
        path: 'src/features/agent-chat/components/ChatComposer.tsx',
        is_dir: false,
        children: [],
      },
    ],
  },
];

const mkSession = (projectId: string) => WorkspaceSession.of(projectId, null);

function buildSources({
  commands = true,
  onPickFile,
}: { commands?: boolean; onPickFile?: (path: string, name: string) => void } = {}) {
  const sources: ComposerPaletteSource[] = [
    createMentionSource(FILES, onPickFile ?? (() => undefined)),
  ];
  if (commands) sources.unshift(createCommandSource(COMMANDS));
  return sources;
}

function seedChatTab() {
  useEditorStore.getState().addTab({
    id: 'tc1',
    scope: { kind: 'workspace', session: mkSession('p1') },
    title: 'Agent Chat',
    data: { kind: 'agent-chat' },
  });
}

interface RenderResult {
  onSend: ReturnType<typeof vi.fn>;
  editor: Editor;
}

function renderComposer(params: { sources?: ComposerPaletteSource[] } = {}): RenderResult {
  const onSend = vi.fn();
  let editor: Editor | null = null;
  render(
    <ChatComposer
      attachments={[]}
      streaming={false}
      chatAgents={[{ id: 'a', name: 'Agent', icon: null }]}
      models={[]}
      selectedModel={null}
      selectedAgent={{ id: 'a', name: 'Agent', icon: null }}
      contextWindow={null}
      tabKey={mkSession('p1').key}
      tabId="tc1"
      sources={params.sources ?? buildSources()}
      onSend={onSend}
      onStop={() => undefined}
      onRemoveAttachment={() => undefined}
      onOpenAttachDrop={() => undefined}
      onModelChange={() => undefined}
    />,
  );
  // 编辑器实例挂在 editable DOM 上（@tiptap/react 写入 editor 字段）。
  const dom = screen.getByRole('textbox') as HTMLElement & { editor?: Editor };
  editor = dom.editor ?? null;
  if (!editor) throw new Error('editor instance unavailable');
  return { onSend, editor };
}

/** 直接对编辑器派发按键（ProseMirror 的键盘处理器挂在 editable DOM 上）。 */
function pressKey(dom: Element, key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(dom, { key, ...init });
}

/** 在编辑器里键入文本（PM 通过 input 事件观察 DOM 变化）。 */
/**
 * 向编辑器键入文本。
 *
 * **必须带 `emitUpdate: true`**：Tiptap 的 `insertContent` 程序化调用默认不发
 * `update` 事件（只有真实用户输入才发），而 `onEmptyChange` / 草稿持久化都挂在
 * `update` 上 —— 不带它，测试会看到「什么都没发生」，用例变成假绿。
 */
function typeText(editor: Editor, text: string) {
  editor.commands.insertContent(text, { emitUpdate: true });
}

describe('ChatComposer × 富文本 composer', () => {
  beforeEach(() => {
    useEditorStore.setState({ tabs: {}, editorLayout: {} });
    seedChatTab();
  });

  it('should send the serialized prompt text on Enter', async () => {
    const { onSend, editor } = renderComposer();
    typeText(editor, 'hello world');
    const dom = screen.getByRole('textbox');

    await waitFor(() => expect(dom).toHaveTextContent(/hello world/));
    pressKey(dom, 'Enter');

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith({ promptText: 'hello world', files: [] }),
    );
  });

  it('should keep the send button disabled while the editor is empty', async () => {
    renderComposer();
    const send = screen.getByTitle('Send');
    expect(send).toBeDisabled();
  });

  /**
   * **空格不算内容** —— 发送前校验这一面。
   *
   * 判据本身（`isComposerEmpty`）的语义在 `submitComposer` 侧直测（见该文件的
   * 单元用例）：本层（ChatComposer）经 `onEmptyChange` 只拿到一个布尔，无法
   * 区分「判据是 isEmpty 还是 trim」—— 在这里断言按钮状态只能测到接线，
   * 测不到判据对错（实测：把判据换回 `editor.isEmpty` 本层用例仍绿）。
   * 因此这里只钉用户可观察的结果：空内容按 Enter 不发送。
   */
  it('should not send when the editor holds only whitespace', async () => {
    const { onSend, editor } = renderComposer();
    typeText(editor, '   ');

    pressKey(screen.getByRole('textbox'), 'Enter');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('should enable the send button once content exists', async () => {
    const { editor } = renderComposer();
    typeText(editor, 'draft');

    await waitFor(() => expect(screen.getByTitle('Send')).toBeEnabled());
  });

  it('should open the command palette for / and insert a command chip', async () => {
    const { onSend, editor } = renderComposer();
    typeText(editor, '/tr');

    const listbox = await screen.findByRole('listbox', { name: '命令补全' });
    expect(within(listbox).getAllByRole('option').length).toBeGreaterThan(0);

    fireEvent.click(within(listbox).getAllByRole('option')[0]);

    // chip 序列化回 `/name `（golden 形状），Enter 把它交给 onSend
    const dom = screen.getByRole('textbox');
    await waitFor(() => expect(dom).toHaveTextContent(/trellis-continue/));
    pressKey(dom, 'Enter');
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith({ promptText: '/trellis-continue ', files: [] }),
    );
  });

  /**
   * AC5（B 方案形态）：`@` 选中 → composer 里出现 file chip，发送时 `files`
   * 由**文档投影**得出（不是另存的附件 state）。
   */
  it('should insert a mention chip and project it into files (AC5)', async () => {
    const { onSend, editor } = renderComposer({ sources: buildSources() });
    typeText(editor, '@ChatComposer');

    const listbox = await screen.findByRole('listbox', { name: '文件补全' });
    fireEvent.click(within(listbox).getAllByRole('option')[0]);

    const dom = screen.getByRole('textbox');
    await waitFor(() => expect(dom).toHaveTextContent(/ChatComposer\.tsx/));

    pressKey(dom, 'Enter');
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith({
        promptText: '@src/features/agent-chat/components/ChatComposer.tsx ',
        files: ['src/features/agent-chat/components/ChatComposer.tsx'],
      }),
    );
  });

  it('should not open a slash palette when the slash source is absent (AC1)', async () => {
    const { editor } = renderComposer({ sources: buildSources({ commands: false }) });
    typeText(editor, '/tr');

    // 没有 slash 源 → 引擎不激活弹层（能力位门控，非「弹了再报错」）
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  /**
   * AC10：composer 正常渲染，且**没有**已退役的附件 chips（`FILE` 徽标）。
   *
   * 文件由编辑器里的 chip 表达（B 方案）：旧 `.wa-at` 区块是「同一份文件两处
   * 显示、退格删 chip 后仍会被发送」的来源，已随附件 state 一起删除。这里用
   * 正向断言（没有 FILE 徽标）表达，避免测试直接扒 DOM。
   */
  it('should not render the retired attachment chips (AC10)', () => {
    renderComposer();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.queryByText('FILE')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^移除 /)).not.toBeInTheDocument();
  });
});
