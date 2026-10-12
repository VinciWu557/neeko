// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildScrollKey } from '@/shared/utils/scrollMemory';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { diffScrollMemoryKey, diffScrollMemoryEnabled } from '../diffScrollMemory';
import type { DiffSource } from '../types';

describe('diffScrollMemoryKey（diff 滚动身份的唯一铸造点）', () => {
  const main = WorkspaceSession.of('p1', null);
  const mainSource: DiffSource = { workspace: main, revision: { type: 'worktree' } };

  it('owner = Workspace key，sub = 文件路径（单文件）', () => {
    expect(diffScrollMemoryKey(mainSource, false, 'src/a.ts')).toBe(
      buildScrollKey('editor.diff', main.key, 'src/a.ts'),
    );
  });

  it('combined 与单文件使用不同 sub，互不串位', () => {
    expect(diffScrollMemoryKey(mainSource, true, 'src/a.ts')).toBe(
      buildScrollKey('editor.diff', main.key, 'combined'),
    );
    expect(diffScrollMemoryKey(mainSource, true, 'src/a.ts')).not.toBe(
      diffScrollMemoryKey(mainSource, false, 'src/a.ts'),
    );
  });

  it('无 diffSource → owner 走空段；worktree 与主仓身份不同', () => {
    expect(diffScrollMemoryKey(undefined, false, 'src/a.ts')).toBe(
      buildScrollKey('editor.diff', null, 'src/a.ts'),
    );
    const worktreeSource: DiffSource = {
      workspace: WorkspaceSession.of('p1', '/tmp/wt'),
      revision: { type: 'worktree' },
    };
    expect(diffScrollMemoryKey(worktreeSource, false, 'src/a.ts')).not.toBe(
      diffScrollMemoryKey(mainSource, false, 'src/a.ts'),
    );
  });
});

describe('diffScrollMemoryEnabled（显式导航意图让位规则）', () => {
  it('无 scrollToPath → 启用记忆', () => {
    expect(diffScrollMemoryEnabled(undefined)).toBe(true);
    expect(diffScrollMemoryEnabled(null)).toBe(true);
  });

  it('有 scrollToPath（Git Log 跳转）→ 让位并作废旧记忆', () => {
    expect(diffScrollMemoryEnabled('src/a.ts')).toBe(false);
  });
});
