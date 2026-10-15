import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConflictStages } from '@/shared/types';
import type { ProjectCommands } from '@/shared/types/project';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

// 避免真实订阅（file-changed / git-status-snapshot / Git 刷新）
vi.mock('@/shared/hooks/useFileChangedEvent', () => ({ useFileChangedEvent: () => {} }));
vi.mock('@/shared/hooks/useGitRefresh', () => ({ useGitRefresh: () => {} }));

const mockOpenProjectFile = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@/features/quick-open', () => ({
  openProjectFile: (...args: unknown[]) => mockOpenProjectFile(...args),
}));

import ConflictView from '../ConflictView';

const WS = WorkspaceSession.of('p1', null);

function side(
  content: string | null,
  extra: { is_binary?: boolean; path?: string } = {},
): ConflictStages['ours'] {
  return {
    path: extra.path ?? 'f.txt',
    content,
    size: content?.length ?? 0,
    is_binary: extra.is_binary ?? false,
    truncated: false,
  };
}

const BOTH_MODIFIED: ConflictStages = {
  path: 'f.txt',
  kind: 'both_modified',
  ancestor: side('base line\n'),
  ours: side('our line\n'),
  theirs: side('their line\n'),
  merged: 'merged text',
  regions: [
    {
      id: 0,
      merged_start: 0,
      merged_end: 3,
      base_lines: ['base line'],
      our_lines: ['our line'],
      their_lines: ['their line'],
      base_start: 0,
      our_start: 0,
      their_start: 0,
    },
  ],
  truncated: false,
  region_mergeable: true,
};

function renderView(filePath: string, stages: ConflictStages | Error, resolveConflict = vi.fn()) {
  const getConflictStages = vi.fn(() =>
    stages instanceof Error ? Promise.reject(stages.message) : Promise.resolve(stages),
  );
  const commands = { getConflictStages, resolveConflict } as unknown as ProjectCommands;
  return {
    resolveConflict,
    ...render(<ConflictView workspace={WS} filePath={filePath} commands={commands} />),
  };
}

beforeEach(() => {
  mockOpenProjectFile.mockClear();
});

describe('ConflictView — 三侧只读展示', () => {
  it('renders the three sides and the conflict regions for a both_modified conflict', async () => {
    renderView('f.txt', BOTH_MODIFIED);

    expect(await screen.findAllByText('our line')).not.toHaveLength(0);
    expect(screen.getAllByText('their line').length).toBeGreaterThan(0);
    expect(screen.getAllByText('base line').length).toBeGreaterThan(0);
    // 区域列表渲染（可区域合并）
    expect(screen.getByText(/Region 1/)).toBeInTheDocument();
  });

  it('renders「我方已删除」instead of an empty file when ours.content is null (R3)', async () => {
    const du: ConflictStages = {
      ...BOTH_MODIFIED,
      kind: 'modify_delete',
      ancestor: side('base\n'),
      ours: null, // 我方删除
      theirs: side('theirs after\n'),
      merged: null,
      regions: [],
      region_mergeable: false,
    };
    renderView('f.txt', du);

    expect(await screen.findByText('（我方已删除）')).toBeInTheDocument();
    // 不可区域合并 ⇒ 不渲染区域列表
    expect(screen.queryByText(/Region 1/)).not.toBeInTheDocument();
  });

  it('does not render regions for a binary conflict, and flags it as non-text-mergeable', async () => {
    const binary: ConflictStages = {
      path: 'img.bin',
      kind: 'binary',
      ancestor: side(null, { is_binary: true }),
      ours: side(null, { is_binary: true }),
      theirs: side(null, { is_binary: true }),
      merged: null,
      regions: [],
      truncated: false,
      region_mergeable: false,
    };
    renderView('img.bin', binary);

    expect(await screen.findByText(/not text-mergeable/)).toBeInTheDocument();
    expect(screen.queryByText(/Region 1/)).not.toBeInTheDocument();
    // 二进制内容不解码 → 绝不渲染乱码
    expect(screen.queryByText(/base line/)).not.toBeInTheDocument();
  });

  it('shows a convergence notice (not an error) when the read rejects (R10)', async () => {
    renderView('f.txt', new Error('no unmerged'));

    expect(await screen.findByText(/Conflict resolved/)).toBeInTheDocument();
    expect(screen.queryByText(/^Error/)).not.toBeInTheDocument();
  });

  it("renders an actually-empty side as empty (content === ''), distinct from a missing stage", async () => {
    const emptyOurs: ConflictStages = {
      ...BOTH_MODIFIED,
      kind: 'modify_delete',
      ancestor: side('base\n'),
      ours: side(''), // 确实存在的空文件（stage 存在但内容为空）
      theirs: side('theirs\n'),
      merged: null,
      regions: [],
      region_mergeable: false,
    };
    renderView('f.txt', emptyOurs);

    expect((await screen.findAllByText('Ours')).length).toBeGreaterThan(0);
    // 空文件 ≠ 已删除：不得出现「已删除」文案
    expect(screen.queryByText('（我方已删除）')).not.toBeInTheDocument();
  });

  it('trusts the backend `region_mergeable` field instead of re-deriving it from `kind`', async () => {
    // 变异钉子：前端曾自持一份 `kind === 'both_modified' || 'both_added'`（第二份领域判据）。
    // 此处故意让 wire 字段与 `kind` 相左：若前端改回按 kind 推导，区域列表会重新出现 ⇒ 红。
    const notMergeableDespiteKind: ConflictStages = {
      ...BOTH_MODIFIED,
      region_mergeable: false,
    };
    renderView('f.txt', notMergeableDespiteKind);

    // 不可区域合并 ⇒ 渲染不透明状态卡（kind 为 both_modified 时的诚实文案），不渲染区域列表
    expect(await screen.findByText('Region-mergeable conflict')).toBeInTheDocument();
    expect(screen.queryByText(/Region 1/)).not.toBeInTheDocument();
  });

  it('still renders regions from structured `MergeRegion` when `merged` is sacrificed by the payload cap', async () => {
    // 真正的健壮性主张：区域渲染只读结构化 `MergeRegion`，**不读派生展示数据 `merged`**。
    // 后端 `cap_conflict_payload` 把 `merged` 当预算余量的牺牲品（design.md §2.3），
    // 因此「region_mergeable=true 且 merged 被截掉」是合法组合，不得退化成不透明卡。
    const mergedSacrificed: ConflictStages = {
      ...BOTH_MODIFIED,
      merged: null,
      truncated: true,
    };
    renderView('f.txt', mergedSacrificed);

    expect(await screen.findByText(/Region 1/)).toBeInTheDocument();
    expect(screen.getAllByText('our line').length).toBeGreaterThan(0);
    // 截断必须上浮到 UI（红线 4 的用户可见面）
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });

  it('opens the conflicted file in the editor via the escape hatch', async () => {
    renderView('f.txt', BOTH_MODIFIED);

    const btn = await screen.findByTitle('Open File');
    btn.click();
    expect(mockOpenProjectFile).toHaveBeenCalledWith({ projectId: 'p1', filePath: 'f.txt' });
  });

  // ── Layer 2：决议交互 ──────────────────────────────────────────────────────

  it('renders per-region Accept Ours/Theirs/Both for a region-mergeable conflict', async () => {
    renderView('f.txt', BOTH_MODIFIED);

    expect(await screen.findByText('Accept Ours')).toBeInTheDocument();
    expect(screen.getByText('Accept Theirs')).toBeInTheDocument();
    expect(screen.getByText('Accept Both')).toBeInTheDocument();
    // 区域可合并的 kind（UU/AA）也提供整文件二选一（与区域草稿互斥，PRD AC：UU 支持整文件）。
    expect(screen.getByText('Take Ours')).toBeInTheDocument();
    expect(screen.getByText('Take Theirs')).toBeInTheDocument();
  });

  it('applies a whole-file resolution for a region-mergeable (UU) conflict', async () => {
    const { resolveConflict } = renderView('f.txt', BOTH_MODIFIED);

    (await screen.findByText('Take Theirs')).click();
    (await screen.findByText('Apply')).click();

    await waitFor(() =>
      expect(resolveConflict).toHaveBeenCalledWith('f.txt', {
        kind: 'whole_file',
        take: 'theirs',
      }),
    );
  });

  it('applies a whole-file resolution from the toolbar (modify_delete)', async () => {
    const du: ConflictStages = {
      ...BOTH_MODIFIED,
      kind: 'modify_delete',
      ancestor: side('base\n'),
      ours: null,
      theirs: side('theirs after\n'),
      merged: null,
      regions: [],
      region_mergeable: false,
    };
    const { resolveConflict } = renderView('f.txt', du);

    (await screen.findByText('Take Theirs')).click();
    (await screen.findByText('Apply')).click();

    await screen.findByText(/Conflict resolved|Take Theirs/);
    expect(resolveConflict).toHaveBeenCalledWith('f.txt', {
      kind: 'whole_file',
      take: 'theirs',
    });
  });

  it('does NOT render resolution buttons for rename/rename (non-goal)', async () => {
    const rr: ConflictStages = {
      ...BOTH_MODIFIED,
      kind: 'rename_rename',
      ancestor: side('a\n', { path: 'a.txt' }),
      ours: side('a\n', { path: 'c.txt' }),
      theirs: side('a\n', { path: 'z.txt' }),
      merged: null,
      regions: [],
      region_mergeable: false,
    };
    renderView('a.txt', rr);

    // 等渲染完成（不透明卡）后确认没有决议按钮。
    await screen.findByText('Rename/rename conflict — not region-mergeable');
    expect(screen.queryByText('Take Ours')).not.toBeInTheDocument();
    expect(screen.queryByText('Take Theirs')).not.toBeInTheDocument();
  });
});
