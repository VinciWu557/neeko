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

  /**
   * 诊断计数从独立徽章移进聚合 title —— 但「可见」这件事不能丢：
   * U2（代码里的代码一律不翻）是产品铁律，用户必须能查到「为什么这句没翻」。
   * 载体变了，可观测性本身是契约。
   */
  it('should expose the code-segment count in the diagnostics tooltip', () => {
    render(<CommentTranslationToolbar {...baseProps} />);
    const diagnostics = screen.getByTitle(/代码不翻 4/);
    expect(diagnostics).toBeInTheDocument();
    expect(diagnostics).toHaveAttribute('title', expect.stringContaining('注释里的代码一律不翻译'));
  });

  it('should expose the skipped-group count in the diagnostics tooltip', () => {
    render(<CommentTranslationToolbar {...baseProps} />);
    const diagnostics = screen.getByTitle(/跳过 2 组/);
    expect(diagnostics).toHaveAttribute('title', expect.stringContaining('许可证'));
  });

  it('should report cache hits only when non-zero', () => {
    const { rerender } = render(<CommentTranslationToolbar {...baseProps} />);
    expect(screen.getByTitle(/可翻译 3 段/).getAttribute('title')).not.toContain('缓存命中');

    rerender(<CommentTranslationToolbar {...baseProps} cacheHits={5} />);
    expect(screen.getByTitle(/缓存命中 5 段/)).toBeInTheDocument();
  });

  it('should show the retry button only when something failed', () => {
    const { rerender } = render(<CommentTranslationToolbar {...baseProps} />);
    expect(screen.queryByRole('button', { name: /失败/ })).not.toBeInTheDocument();

    const onRetryFailed = vi.fn();
    rerender(<CommentTranslationToolbar {...baseProps} failed={2} onRetryFailed={onRetryFailed} />);
    fireEvent.click(screen.getByRole('button', { name: /失败 2/ }));
    expect(onRetryFailed).toHaveBeenCalled();
  });

  /**
   * 运行中不再渲染主按钮，而是换成「已译 N/M + 停止」——与文档翻译同形。
   * 断言的是「主按钮消失了」，比「按钮被禁用」更强：禁用的按钮仍会被点击测试命中。
   */
  it('should swap the primary action for progress and stop while running', () => {
    render(<CommentTranslationToolbar {...baseProps} done={1} running />);
    expect(screen.queryByRole('button', { name: '翻译注释' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新翻译' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '停止翻译' })).toBeInTheDocument();
    expect(screen.getByText('已译 1 / 3')).toBeInTheDocument();
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
