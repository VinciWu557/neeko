import { useCallback, useState } from 'react';

import type { ConflictResolution, RegionTake, TakeSide } from '@/shared/types';
import type { ProjectCommands } from '@/shared/types/project';
import type { WorkspaceSession } from '@/shared/utils/workspaceRef';

interface UseConflictResolveParams {
  commands?: ProjectCommands | null;
  workspace: WorkspaceSession;
  filePath: string;
  /**
   * 该冲突的区域总数（`stages.regions.length`；不可区域合并时为 0）。
   *
   * 区域决议是**全函数**：必须一次覆盖全部区域（后端 `validate_region_decisions` 硬校验）。
   * 因此 `canApply` 要求 `regions.size === regionCount` —— 「分批」在 UX 上是**草稿累积**
   * （逐个决策、一次提交），不是服务端写半截文件（`git add` 即已解决，带 marker 的文件不是已解决）。
   */
  regionCount?: number;
  /** 决议成功后的重拉回调（通常来自 `useConflictStages().reload`）。 */
  onResolved?: () => void;
  /** 失败上报（不静默）。 */
  onShowToast?: (message: string, type?: 'info' | 'error') => void;
}

/**
 * 冲突决议的**待提交草稿**状态模型（design.md §2.2）。
 *
 * 决议是「用户逐个区域点完再一次性 Apply」的本地草稿，故有状态：
 * - 区域决议（`regions`）与整文件决议（`wholeFile`）**互斥** —— 设了其一就清空另一；
 * - **区域决议是全函数**：`canApply` 要求全部区域都已决策（逐个决策、一次提交）；
 * - `apply()` 提交 → 乐观置 `pending`；成功后清空草稿并 `onResolved()`（视图由快照事件收敛）；
 * - 失败回滚到提交前快照 + 上报（不静默）。
 *
 * 草稿是**组件/hook 局部状态**（不进全局 store）—— 它只服务于当前冲突视图的生命周期。
 */
export function useConflictResolve({
  commands,
  workspace,
  filePath,
  regionCount = 0,
  onResolved,
  onShowToast,
}: UseConflictResolveParams) {
  const [wholeFile, setWholeFile] = useState<TakeSide | null>(null);
  const [regions, setRegions] = useState<Map<number, RegionTake>>(new Map());
  const [pending, setPending] = useState(false);

  /** 选某一区域的采用方式（与整文件决议互斥）。 */
  const selectRegion = useCallback((regionId: number, take: RegionTake) => {
    setWholeFile(null);
    setRegions((prev) => {
      const next = new Map(prev);
      next.set(regionId, take);
      return next;
    });
  }, []);

  /** 整文件二选一（清空区域草稿）。 */
  const selectWholeFile = useCallback((take: TakeSide) => {
    setRegions(new Map());
    setWholeFile(take);
  }, []);

  // 区域决议需覆盖全部区域；整文件决议只需选中一侧。
  const allRegionsDecided = regionCount > 0 && regions.size === regionCount;
  const canApply = wholeFile !== null || allRegionsDecided;

  const apply = useCallback(async () => {
    if (wholeFile === null && !allRegionsDecided) return;
    const draft = { wholeFile, regions };
    const resolution: ConflictResolution =
      wholeFile !== null
        ? { kind: 'whole_file', take: wholeFile }
        : { kind: 'regions', decisions: [...regions.entries()] };

    setPending(true);
    try {
      if (commands) {
        await commands.resolveConflict(filePath, resolution);
      } else {
        await (await import('../api/gitApi')).resolveConflict(workspace, filePath, resolution);
      }
      // 成功：清空草稿（视图由 git-status-snapshot 驱动收敛到普通 diff）。
      setWholeFile(null);
      setRegions(new Map());
      onResolved?.();
    } catch (e: unknown) {
      // 失败：回滚到提交前快照（本次提交不改草稿，故恢复快照即回滚）+ 上报。
      setWholeFile(draft.wholeFile);
      setRegions(draft.regions);
      onShowToast?.(String(e), 'error');
    } finally {
      setPending(false);
    }
  }, [
    commands,
    workspace,
    filePath,
    wholeFile,
    regions,
    allRegionsDecided,
    onResolved,
    onShowToast,
  ]);

  return {
    wholeFile,
    regions,
    pending,
    canApply,
    undecidedCount: Math.max(0, regionCount - regions.size),
    selectRegion,
    selectWholeFile,
    apply,
  };
}
