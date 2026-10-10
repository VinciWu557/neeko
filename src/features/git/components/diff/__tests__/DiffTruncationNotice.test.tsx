import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiffSource } from '@/shared/types/git';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import DiffView from '../DiffView';
import type { DiffResult } from '../types';

// useDiffData 在无 commands 时动态 import gitApi.getFileDiff
const getFileDiff = vi.hoisted(() => vi.fn());

vi.mock('@/features/git/api/gitApi', () => ({
  getFileDiff,
}));

// 避免真实订阅（file-changed / Git 刷新）
vi.mock('@/shared/hooks/useFileChangedEvent', () => ({
  useFileChangedEvent: () => {},
}));
vi.mock('@/shared/hooks/useGitRefresh', () => ({
  useGitRefresh: () => {},
}));

const DIFF_SOURCE: DiffSource = {
  workspace: WorkspaceSession.of('p1', null),
  revision: { type: 'worktree' },
};

/** 单文件 diff 的固定形状态：`truncated` 由用例覆写。 */
const baseResult: DiffResult = {
  hunks: [
    {
      old_start: 1,
      old_lines: 1,
      new_start: 1,
      new_lines: 1,
      lines: [{ Removed: 'old-line' }, { Added: 'new-line' }],
    },
  ],
};

const NOTICE = /Diff truncated/;

describe('Diff 截断提示（红线 4 封顶的用户可见面）', () => {
  beforeEach(() => {
    getFileDiff.mockReset();
  });

  it('should_show_notice_when_backend_result_is_truncated', async () => {
    getFileDiff.mockResolvedValue({ ...baseResult, truncated: true });

    render(<DiffView projectId="p1" diffSource={DIFF_SOURCE} filePath="src/a.ts" />);

    await waitFor(() => {
      expect(screen.getByText(NOTICE)).toBeInTheDocument();
    });
  });

  it('should_not_show_notice_when_result_is_complete', async () => {
    getFileDiff.mockResolvedValue({ ...baseResult, truncated: false });

    render(<DiffView projectId="p1" diffSource={DIFF_SOURCE} filePath="src/a.ts" />);

    // 行内容可能被高亮拆成多个 span，故按整体 textContent 判定（避免 getByText 拆词误判）
    await waitFor(() => {
      expect(document.body).toHaveTextContent('new-line');
    });
    expect(document.body).not.toHaveTextContent('Diff truncated');
  });

  // 回归：截断到 0 hunk（单行即超预算）时提示仍必须可见，且不得误显示为「无改动」。
  it('should_show_notice_when_truncation_left_zero_hunks', async () => {
    getFileDiff.mockResolvedValue({ hunks: [], truncated: true });

    render(<DiffView projectId="p1" diffSource={DIFF_SOURCE} filePath="src/a.ts" />);

    await waitFor(() => {
      expect(screen.getByText(NOTICE)).toBeInTheDocument();
    });
    expect(document.body).not.toHaveTextContent('No changes to display');
  });
});
