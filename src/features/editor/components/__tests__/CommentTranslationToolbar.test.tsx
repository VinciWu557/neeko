import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import CommentTranslationToolbar from '../CommentTranslationToolbar';

const baseProps = {
  running: false,
  mode: 'below' as const,
  total: 3,
  done: 2,
  codeSegments: 4,
  skippedGroups: 2,
  failed: 0,
  cacheHits: 0,
  onModeChange: vi.fn(),
  onStart: vi.fn(),
  onStop: vi.fn(),
  onRetryFailed: vi.fn(),
};

describe('CommentTranslationToolbar', () => {
  it('should render the four display modes and mark the active one', () => {
    render(<CommentTranslationToolbar {...baseProps} />);
    for (const label of ['对照', '行内', '悬停', '关闭']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: '对照' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '关闭' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('should call onModeChange when a mode is clicked', () => {
    const onModeChange = vi.fn();
    render(<CommentTranslationToolbar {...baseProps} onModeChange={onModeChange} />);
    fireEvent.click(screen.getByRole('button', { name: '悬停' }));
    expect(onModeChange).toHaveBeenCalledWith('hover');
  });

  it('should show the code-segment counter so users see why some text is not translated', () => {
    render(<CommentTranslationToolbar {...baseProps} />);
    // U2 的可观测性：代码段数必须可见
    expect(screen.getByTitle('注释中的代码一律不翻译（含死代码与示例）')).toBeInTheDocument();
  });

  it('should show the skipped-group counter', () => {
    render(<CommentTranslationToolbar {...baseProps} />);
    expect(screen.getByTitle('工具链指令 / 许可证 / shebang 整组跳过')).toBeInTheDocument();
  });

  it('should show cache hits only when non-zero', () => {
    const { rerender } = render(<CommentTranslationToolbar {...baseProps} />);
    expect(screen.queryByTitle('命中缓存的段数（增量生效的证明）')).not.toBeInTheDocument();

    rerender(<CommentTranslationToolbar {...baseProps} cacheHits={5} />);
    expect(screen.getByTitle('命中缓存的段数（增量生效的证明）')).toBeInTheDocument();
  });

  it('should show the retry button only when something failed', () => {
    const { rerender } = render(<CommentTranslationToolbar {...baseProps} />);
    expect(screen.queryByRole('button', { name: /失败/ })).not.toBeInTheDocument();

    const onRetryFailed = vi.fn();
    rerender(<CommentTranslationToolbar {...baseProps} failed={2} onRetryFailed={onRetryFailed} />);
    fireEvent.click(screen.getByRole('button', { name: /失败 2/ }));
    expect(onRetryFailed).toHaveBeenCalled();
  });

  it('should disable the start button while running and show stop', () => {
    render(<CommentTranslationToolbar {...baseProps} done={0} running />);
    expect(screen.getByRole('button', { name: '翻译注释' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '停止翻译' })).toBeInTheDocument();
  });

  it('should call onStart when the primary action is clicked', () => {
    const onStart = vi.fn();
    render(<CommentTranslationToolbar {...baseProps} done={0} onStart={onStart} />);
    fireEvent.click(screen.getByRole('button', { name: '翻译注释' }));
    expect(onStart).toHaveBeenCalled();
  });

  it('should label the action as retranslate when there is existing output', () => {
    render(<CommentTranslationToolbar {...baseProps} done={2} />);
    expect(screen.getByRole('button', { name: '重新翻译' })).toBeInTheDocument();
  });
});
