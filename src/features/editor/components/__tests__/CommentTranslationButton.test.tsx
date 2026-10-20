/**
 * 头部翻译按钮的行为测试。
 *
 * 测的是**用户能感知的三种状态**，不是实现：
 * 空闲 → 点击开始；运行中 → 图标变进度、点击停止；已有结果 → aria-pressed 为真。
 *
 * hook 与配置都被替身化：本文件关心的是「按钮把状态映射成什么动作」，
 * 翻译引擎自己的行为在 `useCommentTranslateActions` / `translateSegments` 里测。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const start = vi.fn();
const stop = vi.fn();
let mockState = {
  running: false,
  mode: 'below' as const,
  total: 0,
  done: 0,
  codeSegments: 0,
  skippedGroups: 0,
  failed: 0,
  cacheHits: 0,
};
let mockSupported = true;
let mockConfig: { translation?: Record<string, unknown> } = {};

vi.mock('@/shared/contexts/AppContext', () => ({
  // `agents` 参与「配置里的 agentId 是否仍可用」的解析，缺它会 TypeError。
  useAppContext: () => ({
    config: mockConfig,
    agents: [{ id: 'opencode', name: 'OpenCode', command: 'opencode', chat: { transport: 'sdk' } }],
  }),
}));

// 按钮现在会拉取当前 agent 的模型列表（agent 与 model 一起解析）。
// 单测不关心模型发现，给一个固定空列表 —— 解析结果的 modelId 自然是 null。
vi.mock('@/features/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/agent')>()),
  useAgentModels: () => ({ models: [], loading: false }),
}));

vi.mock('../../hooks/useCommentTranslateActions', () => ({
  useCommentTranslateActions: () => ({
    state: mockState,
    supported: mockSupported,
    start,
    stop,
  }),
}));

const { default: CommentTranslationButton } = await import('../CommentTranslationButton');

const baseProps = {
  filePath: 'a.ts',
  projectId: 'p1' as never,
  editorViewRef: { current: null },
  content: '// hi',
};

function setState(patch: Partial<typeof mockState>) {
  mockState = { ...mockState, ...patch };
}

describe('CommentTranslationButton', () => {
  it('should start translation when idle', () => {
    setState({ running: false, total: 0, done: 0 });
    mockSupported = true;
    mockConfig = {};
    render(<CommentTranslationButton {...baseProps} />);

    fireEvent.click(screen.getByRole('button', { name: '翻译注释' }));
    expect(start).toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('should stop translation when running', () => {
    start.mockClear();
    stop.mockClear();
    setState({ running: true, total: 3, done: 1 });
    render(<CommentTranslationButton {...baseProps} />);

    fireEvent.click(screen.getByRole('button', { name: /停止翻译/ }));
    expect(stop).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('should label the action as retranslate when there is existing output', () => {
    setState({ running: false, total: 3, done: 2 });
    render(<CommentTranslationButton {...baseProps} />);
    expect(screen.getByRole('button', { name: /重新翻译注释/ })).toBeInTheDocument();
  });

  /** 失败数进 title：不占视觉空间，但用户能查到上次为什么没跑完。 */
  it('should surface the failure count in the tooltip', () => {
    setState({ running: false, total: 3, done: 0, failed: 274 });
    render(<CommentTranslationButton {...baseProps} />);
    expect(screen.getByRole('button')).toHaveAttribute(
      'title',
      expect.stringContaining('274 组失败'),
    );
  });

  /**
   * 门控：语言无注释语义（如 .json）时不渲染按钮 ——
   * 宁可没有按钮，也不给一个点了什么都不会发生的按钮。
   */
  it('should render nothing when the language has no comment syntax', () => {
    mockSupported = false;
    setState({ running: false, total: 0, done: 0 });
    const { container } = render(<CommentTranslationButton {...baseProps} />);
    expect(container).toBeEmptyDOMElement();
  });
});
