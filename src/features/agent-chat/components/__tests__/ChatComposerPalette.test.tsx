import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import ChatComposer from '../ChatComposer';
import { createCommandSource, createMentionSource } from '../paletteSources';
import type { ComposerPaletteSource } from '../paletteSources';

/**
 * ChatComposer × 补全弹层的集成测试（阶段 4，真实数据源工厂）。
 *
 * 覆盖：触发弹层（AC1/AC4）、**AC7 双触发**（弹层打开时 Enter 不得发送）、
 * Esc 后恢复发送、**AC8 IME 组合期**、点击候选写回，以及 **能力位门控**
 * （AC1：capabilities.commands 为 false 的传输不挂 slash 源，`/` 不弹层）。
 * 纯函数与 hook 层的判据细节在 paletteTrigger.test.ts / paletteSources.test.ts。
 */

const COMMANDS = [
  { name: 'trellis-continue', description: 'Resume work on the current task', source: 'prompt' },
  { name: 'trellis-start', description: 'Start a Trellis task session', source: 'prompt' },
  { name: 'skill:code-walkthrough', description: 'Walk through code', source: 'skill' },
];

const FILES = [
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
      {
        name: 'editorStore.ts',
        path: 'src/features/agent-chat/editorStore.ts',
        is_dir: false,
        children: [],
      },
    ],
  },
];

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

function TestComposer({
  onKeyDownSpy,
  sources,
}: {
  onKeyDownSpy: (e: React.KeyboardEvent) => void;
  sources: ComposerPaletteSource[];
}) {
  const [input, setInput] = useState('');
  return (
    <ChatComposer
      input={input}
      attachments={[]}
      streaming={false}
      chatAgents={[{ id: 'a', name: 'Agent', icon: null }]}
      models={[]}
      selectedModel={null}
      selectedAgent={{ id: 'a', name: 'Agent', icon: null }}
      contextWindow={null}
      tabKey="k"
      tabId="t"
      onInputChange={(e) => setInput(e.target.value)}
      onKeyDown={onKeyDownSpy}
      onSend={() => undefined}
      onStop={() => undefined}
      onRemoveAttachment={() => undefined}
      onOpenAttachDrop={() => undefined}
      onModelChange={() => undefined}
      onReplaceInput={(text) => setInput(text)}
      sources={sources}
    />
  );
}

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
}

async function renderComposer(sources: ComposerPaletteSource[]) {
  const onKeyDownSpy = vi.fn();
  render(<TestComposer onKeyDownSpy={onKeyDownSpy} sources={sources} />);
  const textarea = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
  return { onKeyDownSpy, textarea };
}

describe('ChatComposer 补全弹层', () => {
  it('should open the command palette when typing / at start', async () => {
    const { textarea } = await renderComposer(buildSources());
    typeInto(textarea, '/');

    const listbox = await screen.findByRole('listbox', { name: '命令补全' });
    expect(listbox).toBeInTheDocument();
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });

  it('should open the mention palette for @ and filter by path', async () => {
    const { textarea } = await renderComposer(buildSources());
    typeInto(textarea, '@');

    const listbox = await screen.findByRole('listbox', { name: '文件补全' });
    const all = within(listbox).getAllByRole('option').length;

    typeInto(textarea, '@editor');
    expect(
      within(screen.getByRole('listbox', { name: '文件补全' })).getAllByRole('option').length,
    ).toBeLessThan(all);
  });

  /**
   * AC1 的能力位门控：`capabilities.commands` 为 false 的传输**不挂 slash 源**
   * —— `/` 完全不触发，也不发起 `list_agent_commands` 查询（查询侧的行为由
   * useAgentCommands.test.ts 钉住；这里钉的是「入口不出现」）。
   *
   * 变异验证：在 AgentChatTabView 的 sources 装配里去掉 commandsEnabled 门控 →
   * composerWiring 的门控用例红；在本组件里无视 sources 缺失 → 本用例红。
   */
  it('should not open a slash palette when the slash source is absent (AC1)', async () => {
    const { textarea } = await renderComposer(buildSources({ commands: false }));
    typeInto(textarea, '/tr');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  /**
   * AC7 的核心用例：弹层打开时 Enter 必须只选中候选。
   *
   * 变异验证：去掉 ChatComposer onKeyDown 里的弹层短路 → 本用例红
   * （onKeyDownSpy 被调用 = 同时触发了发送路径）。
   */
  it('should not forward Enter to the send path while the palette is open (AC7)', async () => {
    const { onKeyDownSpy, textarea } = await renderComposer(buildSources());
    typeInto(textarea, '/tr');
    await screen.findByRole('listbox');

    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onKeyDownSpy).not.toHaveBeenCalled();
    // 选中写回：输入框值被替换成候选（触发符 + value + 尾随空格）
    await waitFor(() => expect(textarea.value).toBe('/trellis-start '));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('should restore the send path after Escape (AC10)', async () => {
    const { onKeyDownSpy, textarea } = await renderComposer(buildSources());
    typeInto(textarea, '/');
    await screen.findByRole('listbox');

    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    // 已输入文本保留，Enter 回到发送路径（这里以父级 onKeyDown 被调用为证）
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onKeyDownSpy).toHaveBeenCalledTimes(1);
  });

  it('should write back the candidate when clicking it', async () => {
    const { textarea } = await renderComposer(buildSources());
    typeInto(textarea, '/');
    await screen.findByRole('listbox');

    fireEvent.click(screen.getAllByRole('option')[0]);
    expect(textarea.value).toBe('/trellis-continue ');
  });

  /**
   * AC5：选中文件 → 写入 `@path ` **且**文件进入 attachments（onPick 副作用）。
   */
  it('should attach the file and write back @path when a mention is picked (AC5)', async () => {
    const onPickFile = vi.fn();
    const { textarea } = await renderComposer(buildSources({ commands: false, onPickFile }));
    typeInto(textarea, '@comp');
    const listbox = await screen.findByRole('listbox', { name: '文件补全' });

    fireEvent.click(within(listbox).getAllByRole('option')[0]);

    expect(textarea.value).toBe('@src/features/agent-chat/components/ChatComposer.tsx ');
    expect(onPickFile).toHaveBeenCalledWith(
      'src/features/agent-chat/components/ChatComposer.tsx',
      'ChatComposer.tsx',
    );
  });

  it('should not open the palette while an IME composition is in progress (AC8)', async () => {
    const { textarea } = await renderComposer(buildSources());

    fireEvent.compositionStart(textarea);
    typeInto(textarea, '/');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.compositionEnd(textarea);
    typeInto(textarea, '/trellis');
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
  });

  /**
   * 组合期的 Enter 是「确认候选上屏」，不是发送 —— 弹层在组合期返回 false
   * 放行后，发送路径若不拦截，拼音上屏的 Enter 会直接把草稿发出去。
   *
   * 变异验证：去掉 ChatComposer handleComposerKeyDown 里的 composing 短路 →
   * 本用例红（onKeyDownSpy 被调）。
   */
  it('should not forward Enter to the send path while an IME composition is in progress', async () => {
    const { onKeyDownSpy, textarea } = await renderComposer(buildSources());
    typeInto(textarea, 'some draft');

    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onKeyDownSpy).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onKeyDownSpy).toHaveBeenCalledTimes(1);
  });

  it('should keep the typed text in the field when Escape closes (AC10)', async () => {
    const { textarea } = await renderComposer(buildSources());
    typeInto(textarea, '/tr');
    await screen.findByRole('listbox');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(textarea.value).toBe('/tr');
  });

  /**
   * 弹层过期状态防线：光标经点击移动后**没有 change 事件**，弹层仍展示旧状态。
   * keydown 消费前必须用真实光标重新校验 —— 失效即关闭并放行（Enter 回到发送），
   * 而不是在旧触发位置写回候选（文本被改错地方 + 发送被吞的双重缺陷）。
   *
   * 变异验证：去掉 handleKeyDown 里的光标重新校验 → 本用例红（onKeyDownSpy
   * 不被调，且 textarea.value 被改写成候选）。
   */
  it('should re-validate the trigger against the real caret before consuming keys', async () => {
    const { onKeyDownSpy, textarea } = await renderComposer(buildSources());
    typeInto(textarea, '/tr');
    await screen.findByRole('listbox');

    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onKeyDownSpy).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe('/tr');
  });

  it('should still pick when the caret matches the active trigger state', async () => {
    const { onKeyDownSpy, textarea } = await renderComposer(buildSources());
    typeInto(textarea, '/tr');
    await screen.findByRole('listbox');

    // 选区事件但光标仍在触发段末尾（与 active 状态一致）→ 校验通过，Enter 照常选中
    textarea.setSelectionRange(3, 3);
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onKeyDownSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(textarea.value).toBe('/trellis-continue '));
  });
});

/**
 * 输入框内高亮层（AC11，design §10）：已插入的 `/命令` 与 `@文件` 在 composer
 * 里以高亮 token 呈现 —— textarea 文字透明 + 同排版镜像 div 按 token 区间渲染。
 * 判据细节（`src/foo` 不高亮、护栏等）在 paletteHighlight.test.ts。
 */
describe('输入框内高亮层 (AC11)', () => {
  it('should render an inserted mention as a highlighted token', async () => {
    const { textarea } = await renderComposer(buildSources({ commands: false }));
    typeInto(textarea, '@src/app/App.tsx ');

    const mirror = screen.getByTestId('composer-mirror');
    const token = within(mirror).getByTestId('composer-token-mention');
    expect(token).toHaveTextContent('@src/app/App.tsx');
    // 镜像层必须逐字渲染全部内容（含 token 之外与尾随空格），与透明文字对齐
    expect(mirror).toHaveTextContent(textarea.value, { normalizeWhitespace: false });
  });

  it('should render an inserted slash command as a highlighted token', async () => {
    const { textarea } = await renderComposer(buildSources());
    typeInto(textarea, '/trellis-continue ');

    const mirror = screen.getByTestId('composer-mirror');
    expect(within(mirror).getByTestId('composer-token-slash')).toHaveTextContent(
      '/trellis-continue',
    );
    expect(mirror).toHaveTextContent(textarea.value, { normalizeWhitespace: false });
  });

  it('should not highlight tokens in plain text (src/foo stays plain)', async () => {
    const { textarea } = await renderComposer(buildSources({ commands: false }));
    typeInto(textarea, 'look at src/foo/bar.ts');

    const mirror = screen.getByTestId('composer-mirror');
    expect(within(mirror).queryByTestId(/composer-token-/)).not.toBeInTheDocument();
    expect(mirror).toHaveTextContent(textarea.value);
  });

  /**
   * IME 组合期（AC8 邻近回归）：WebKit 下透明文字会让组合文本不可见 ——
   * composing 置位时镜像层视觉隐藏（`visibility: hidden`，保持挂载避免组合期
   * DOM 抖动）、textarea 恢复原生渲染；compositionend 后恢复可见。
   *
   * 变异验证：去掉 ComposerMirror 里的 suspended → visibility 门控 → 本用例红。
   */
  it('should keep the mirror mounted but visually hidden while composing', async () => {
    const { textarea } = await renderComposer(buildSources({ commands: false }));
    typeInto(textarea, '/cmd ');
    const mirror = screen.getByTestId('composer-mirror');
    expect(mirror).toHaveStyle({ visibility: 'visible' });

    fireEvent.compositionStart(textarea);
    expect(screen.getByTestId('composer-mirror')).toHaveStyle({ visibility: 'hidden' });
    expect(textarea).toHaveClass('composing');

    fireEvent.compositionEnd(textarea);
    expect(screen.getByTestId('composer-mirror')).toHaveStyle({ visibility: 'visible' });
    expect(textarea).not.toHaveClass('composing');
  });

  /**
   * 占位符：文字透明后 placeholder 仍走自己的颜色声明（CSS 层事实），
   * 这里钉属性仍在、且空输入时镜像层无内容可渲染（不会遮盖 placeholder）。
   */
  it('should keep the placeholder attribute intact with transparent text', async () => {
    const { textarea } = await renderComposer(buildSources({ commands: false }));
    expect(textarea.placeholder).toBe('Type a message...');
    expect(screen.getByTestId('composer-mirror')).toHaveTextContent('');
  });

  /**
   * 镜像层常驻挂载（WebKit IME 三层加固之一）：组合期不再 unmount/remount，
   * scrollTop 天然恒同步 —— 旧的重组补偿 effect 已删除，这里钉住它的替代
   * 不变量：滚动同步跨组合期持续有效，scrollTop 不归零。
   *
   * 变异验证：恢复卸载式实现（组合期 return null）→ 本用例红（重挂载后
   * scrollTop 归零）。
   */
  it('should keep the mirror mounted and scroll-synced across composition', async () => {
    const { textarea } = await renderComposer(buildSources({ commands: false }));
    // jsdom 不做布局，直接赋值 + 手动派发 scroll 事件模拟 textarea 已滚动
    textarea.scrollTop = 120;
    fireEvent.scroll(textarea);
    expect(screen.getByTestId('composer-mirror').scrollTop).toBe(120);

    fireEvent.compositionStart(textarea);
    fireEvent.compositionEnd(textarea);
    expect(screen.getByTestId('composer-mirror').scrollTop).toBe(120);
  });
});
