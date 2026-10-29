import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import FileEditorFallback from '@/features/editor/components/FileEditorFallback';
import type { FileTab } from '@/shared/types';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

function imageTab(worktreePath: string | null, filePath = 'img/a.png'): FileTab {
  return {
    id: 't1',
    workspace: WorkspaceSession.of('p1', worktreePath),
    filePath,
    fileName: filePath.split('/').pop() ?? filePath,
    content: { path: filePath, content: '', size: 10, is_binary: true },
    isDirty: false,
  } as FileTab;
}

function imgSrc(name: string): string | null {
  return screen.getByAltText(name).getAttribute('src');
}

describe('FileEditorFallback — 图片预览的路径基准', () => {
  it('主 checkout 单元：基准是 projectPath', () => {
    render(<FileEditorFallback kind="image" tab={imageTab(null)} projectPath="/repo" />);
    expect(imgSrc('a.png')).toBe('asset://localhost//repo/img/a.png');
  });

  it('linked worktree 单元：基准是工作树根，不是主仓根（回归锁定）', () => {
    // 历史实现把「project.path 派生的绝对路径」交给预览 ⇒ worktree 下图片恒指向主仓。
    // 基准的唯一派生点是 workspaceRootOf(tab.workspace.key, projectPath)。
    render(
      <FileEditorFallback
        kind="image"
        tab={imageTab('/repo/.worktrees/feat-x')}
        projectPath="/repo"
      />,
    );
    expect(imgSrc('a.png')).toBe('asset://localhost//repo/.worktrees/feat-x/img/a.png');
    expect(imgSrc('a.png')).not.toContain('//repo/img/a.png');
  });

  it('projectPath 缺失时不猜路径（交由 asset 协议/调用方兜底）', () => {
    render(<FileEditorFallback kind="image" tab={imageTab(null)} projectPath={null} />);
    // 无基准 → 相对路径保持原样（不渲染成错误的主仓路径）
    expect(imgSrc('a.png')).toBe('img/a.png');
  });
});
