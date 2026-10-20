/**
 * Editor 设置页的翻译项接线测试。
 *
 * 测的是一件事：**选了 agent / 模型之后，回调真的被调用**。
 * 这几项曾经只存在于 config 类型里、UI 上完全没有入口（`modelId` 尤其如此）——
 * 那种「字段有、界面无」的缺陷不会被任何类型检查发现。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `chat` 能力决定它是否出现在翻译 agent 下拉里（`agentCapabilities(a).chat`）。
const agent = {
  id: 'claude-code',
  name: 'Claude Code',
  command: 'claude',
  chat: { transport: 'sdk' },
} as never;

vi.mock('@/features/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/agent')>()),
  useAgentModels: () => ({
    models: [
      { id: 'm1', name: 'Model One' },
      { id: 'm2', name: 'Model Two' },
    ],
    loading: false,
  }),
}));

const { default: EditorPanel } = await import('../EditorPanel');

const baseProps = {
  editorFontSize: 14,
  onEditorFontSizeChange: vi.fn(),
  autoLocateFileOnTabSwitch: false,
  onAutoLocateFileOnTabSwitchChange: vi.fn(),
  editorGitChangeHighlight: false,
  onEditorGitChangeHighlightChange: vi.fn(),
  watcherExclude: [],
  onWatcherExcludeChange: vi.fn(),
  agents: [agent],
  onTranslationAgentChange: vi.fn(),
  onTranslationModelChange: vi.fn(),
  onTranslationTargetLanguageChange: vi.fn(),
  onCommentTranslationModeChange: vi.fn(),
  onCommentTranslationAutoWarmChange: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EditorPanel / 翻译设置', () => {
  it('should expose an agent selector', () => {
    render(<EditorPanel {...baseProps} translationAgentId="claude-code" />);
    expect(screen.getByLabelText('Default translation agent')).toBeInTheDocument();
  });

  it('should call onTranslationAgentChange when an agent is picked', () => {
    const onTranslationAgentChange = vi.fn();
    render(
      <EditorPanel
        {...baseProps}
        translationAgentId=""
        onTranslationAgentChange={onTranslationAgentChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Default translation agent'), {
      target: { value: 'claude-code' },
    });
    expect(onTranslationAgentChange).toHaveBeenCalledWith('claude-code');
  });

  /** 模型选择器：这是本轮新增的入口。 */
  it('should expose a model selector listing the agent models', () => {
    render(<EditorPanel {...baseProps} translationAgentId="claude-code" />);

    const select = screen.getByLabelText('Default translation model');
    expect(select).toBeEnabled();
    expect(screen.getByRole('option', { name: 'Model One' })).toBeInTheDocument();
  });

  it('should call onTranslationModelChange with the chosen model', () => {
    const onTranslationModelChange = vi.fn();
    render(
      <EditorPanel
        {...baseProps}
        translationAgentId="claude-code"
        onTranslationModelChange={onTranslationModelChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Default translation model'), {
      target: { value: 'm2' },
    });
    expect(onTranslationModelChange).toHaveBeenCalledWith('m2');
  });

  /** 空值 = 交回 agent 自己决定，契约是 `null` 而不是空字符串。 */
  it('should send null when the model is cleared', () => {
    const onTranslationModelChange = vi.fn();
    render(
      <EditorPanel
        {...baseProps}
        translationAgentId="claude-code"
        translationModelId="m1"
        onTranslationModelChange={onTranslationModelChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Default translation model'), {
      target: { value: '' },
    });
    expect(onTranslationModelChange).toHaveBeenCalledWith(null);
  });

  /**
   * 陈旧 agentId 必须**显式可见**。
   *
   * 实测：HTML select 遇到不在 options 里的 value 会回落显示第一项，
   * 于是「配置里存着一个已删除的 agent」在界面上表现得像「没设置」——
   * 用户看不出问题，而翻译时照旧用那个坏 id 去请求。
   */
  it('should surface a stale agent id instead of silently showing "Agent default"', () => {
    render(<EditorPanel {...baseProps} translationAgentId="deleted-agent" />);

    const select = screen.getByLabelText('Default translation agent') as HTMLSelectElement;
    expect(select.value).toBe('deleted-agent');
    expect(screen.getByRole('option', { name: /deleted-agent.*unavailable/ })).toBeInTheDocument();
  });

  it('should not add a stale entry when the configured agent is available', () => {
    render(<EditorPanel {...baseProps} translationAgentId="claude-code" />);
    expect(screen.queryByRole('option', { name: /unavailable/ })).not.toBeInTheDocument();
  });

  it('should expose the comment display mode selector', () => {
    render(<EditorPanel {...baseProps} commentTranslationMode="below" />);
    expect(screen.getByLabelText('Comment translation display mode')).toBeInTheDocument();
  });
});
