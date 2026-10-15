import type { FileChange, DiffRevision } from '@/shared/types';

import { isConflictedEntry } from './gitStatusGroups';

/**
 * 点击变更列表某文件 → 该开哪种 diff 视图（**入口决策纯函数**）。
 *
 * 复用 `isConflictedEntry`（前端唯一冲突判定，`gitStatusGroups.ts`）—— 禁止在此另造
 * 第二套 XY 判定。这修掉了本地 git2 路径下冲突文件显示「No changes to display」的入口
 * 成因：此前 `useOpenDiffTab` 无条件开 `{ type: 'worktree' }`，而 git2 对冲突文件的
 * delta = `Delta::Conflicted`、hunks = 0 → 空态（`prd.md` R6 / E1）。
 *
 * 非冲突 → `worktree`（既有行为不变）。
 */
export function revisionForChange(file: FileChange): DiffRevision {
  return isConflictedEntry(file) ? { type: 'conflict' } : { type: 'worktree' };
}
