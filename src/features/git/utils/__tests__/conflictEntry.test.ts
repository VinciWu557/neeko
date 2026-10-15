// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { FileChange } from '@/shared/types';

import { revisionForChange } from '../conflictEntry';

function file(overrides: Partial<FileChange>): FileChange {
  return {
    path: 'src/a.ts',
    status: 'Modified',
    additions: 0,
    deletions: 0,
    ...overrides,
  };
}

describe('revisionForChange', () => {
  it('XY 任一侧为 U（UU / DU / UD）→ conflict 修订', () => {
    expect(revisionForChange(file({ index_status: 'U', worktree_status: 'U' }))).toEqual({
      type: 'conflict',
    });
    expect(revisionForChange(file({ index_status: 'D', worktree_status: 'U' }))).toEqual({
      type: 'conflict',
    });
    expect(revisionForChange(file({ index_status: 'U', worktree_status: 'D' }))).toEqual({
      type: 'conflict',
    });
  });

  it('AA（双方各自新增同名）→ conflict 修订', () => {
    expect(revisionForChange(file({ index_status: 'A', worktree_status: 'A' }))).toEqual({
      type: 'conflict',
    });
  });

  it('DD（双方都删）→ conflict 修订（与 isConflictedEntry 同一判定，不另造第二套）', () => {
    expect(revisionForChange(file({ index_status: 'D', worktree_status: 'D' }))).toEqual({
      type: 'conflict',
    });
  });

  it('普通改动 / 未跟踪 / 缺 XY → worktree 修订', () => {
    expect(revisionForChange(file({ index_status: ' ', worktree_status: 'M' }))).toEqual({
      type: 'worktree',
    });
    expect(revisionForChange(file({ index_status: 'M', worktree_status: ' ' }))).toEqual({
      type: 'worktree',
    });
    expect(revisionForChange(file({ status: 'Untracked' }))).toEqual({ type: 'worktree' });
    expect(revisionForChange(file({ index_status: '?', worktree_status: '?' }))).toEqual({
      type: 'worktree',
    });
  });
});
