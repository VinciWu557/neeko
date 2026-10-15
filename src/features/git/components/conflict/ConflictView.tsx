import React, { useCallback } from 'react';

import { openProjectFile } from '@/features/quick-open';
import type { ConflictKind, ConflictStages, RegionTake } from '@/shared/types';
import type { ProjectCommands } from '@/shared/types/activeProject';
import type { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { useConflictResolve } from '../../hooks/useConflictResolve';
import { useConflictStages } from '../../hooks/useConflictStages';

import ConflictOpaqueCard from './ConflictOpaqueCard';
import ConflictRegionBlock from './ConflictRegionBlock';
import ConflictSidePanel from './ConflictSidePanel';
import ConflictToolbar from './ConflictToolbar';

interface ConflictViewProps {
  /** 地址权威（红线 12）：冲突读/写命令按此Workspace寻址。 */
  workspace: WorkspaceSession;
  filePath: string;
  commands?: ProjectCommands | null;
  onBack?: () => void;
  onShowToast?: (message: string, type?: 'info' | 'error') => void;
}

function missingHintFor(side: 'base' | 'ours' | 'theirs', kind: ConflictKind): string {
  if (side === 'ours') return '（我方已删除）';
  if (side === 'theirs') return '（对方已删除）';
  return kind === 'both_added' ? '（无共同祖先）' : '（无 base）';
}

/**
 * 冲突文件的三侧视图（`DiffView` 的兄弟，不是改造它）：三侧内容 + 区域列表 + 决议
 * （逐区域 Ours/Theirs/Both 或整文件二选一）+ 「在编辑器打开」逃生门 + 截断提示。
 *
 * 真值来自后端 `get_conflict_stages`（index unmerged stages），**不解析工作区 marker**
 * （护栏 A4）。决议落盘由 `useConflictResolve` 提交给后端 `resolve_conflict`，
 * 成功后由 `git-status-snapshot` 事件驱动收敛回普通 diff。
 */
const ConflictView: React.FC<ConflictViewProps> = ({
  workspace,
  filePath,
  commands,
  onBack,
  onShowToast,
}) => {
  const { stages, loading, error, notConflicted, reload } = useConflictStages({
    commands,
    workspace,
    filePath,
  });
  const resolve = useConflictResolve({
    commands,
    workspace,
    filePath,
    regionCount: stages?.regions.length ?? 0,
    onResolved: () => void reload(),
    onShowToast,
  });

  const handleOpenFile = useCallback(() => {
    void openProjectFile({ projectId: workspace.projectId, filePath });
  }, [workspace.projectId, filePath]);

  if (notConflicted) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-bg-secondary text-[var(--font-size)]">
        <p className="text-text-muted">Conflict resolved — reopening diff…</p>
        {onBack ? (
          <button
            type="button"
            className="rounded border border-border/50 px-2 py-0.5 text-text-muted hover:bg-bg-hover hover:text-text-primary"
            onClick={onBack}
          >
            Back
          </button>
        ) : null}
      </div>
    );
  }

  if (loading && !stages) {
    return (
      <div
        className="flex h-full items-center justify-center bg-bg-secondary text-[var(--font-size)] text-text-muted"
        aria-busy="true"
      >
        Loading conflict…
      </div>
    );
  }

  if (error || !stages) {
    return (
      <div className="flex h-full items-center justify-center bg-bg-secondary text-[var(--font-size)]">
        <p className="text-accent-red">Error: {error ?? 'unknown'}</p>
      </div>
    );
  }

  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  // 「哪些 kind 可区域合并」是**决议语义**（design.md §0.1：删除不是内容），权威在后端。
  // 此处直接消费 wire 字段，不再持第二份判据（改一处必漏另一处）。
  const regionMergeable = stages.region_mergeable;

  return (
    <ConflictViewBody
      stages={stages}
      fileName={fileName}
      filePath={filePath}
      regionMergeable={regionMergeable}
      onOpenFile={handleOpenFile}
      resolution={resolve}
    />
  );
};

interface ConflictViewBodyProps {
  stages: ConflictStages;
  fileName: string;
  filePath: string;
  regionMergeable: boolean;
  onOpenFile: () => void;
  resolution: ReturnType<typeof useConflictResolve>;
}

const ConflictViewBody: React.FC<ConflictViewBodyProps> = ({
  stages,
  fileName,
  filePath,
  regionMergeable,
  onOpenFile,
  resolution,
}) => {
  // rename/rename 决议 = 非目标（T19）：三侧路径不同，单条决议无法闭合整组。
  const resolvable = stages.kind !== 'rename_rename';
  // 整文件二选一：任何可决议的 kind 都提供（UU/AA 也常有「整文件用某一侧」的诉求，
  // 比逐区域快）。与区域草稿**互斥**（`useConflictResolve` 保证），故两者可共存。
  const wholeFileResolvable = resolvable;
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-bg-secondary">
      <ConflictToolbar
        fileName={fileName}
        filePath={filePath}
        kind={stages.kind}
        regionCount={stages.regions.length}
        undecidedCount={regionMergeable ? resolution.undecidedCount : 0}
        truncated={stages.truncated}
        onOpenFile={onOpenFile}
        wholeFileTake={wholeFileResolvable ? resolution.wholeFile : null}
        onTakeWholeFile={wholeFileResolvable ? resolution.selectWholeFile : undefined}
        canApply={resolution.canApply}
        pending={resolution.pending}
        onApply={resolvable ? resolution.apply : undefined}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
        {!regionMergeable ? <ConflictOpaqueCard stages={stages} /> : null}

        <div className="flex min-h-0 shrink-0 gap-2" style={{ minHeight: 160 }}>
          <ConflictSidePanel
            label="Ours"
            missingHint={missingHintFor('ours', stages.kind)}
            side={stages.ours}
          />
          <ConflictSidePanel
            label="Base"
            missingHint={missingHintFor('base', stages.kind)}
            side={stages.ancestor}
          />
          <ConflictSidePanel
            label="Theirs"
            missingHint={missingHintFor('theirs', stages.kind)}
            side={stages.theirs}
          />
        </div>

        {regionMergeable && stages.regions.length > 0 ? (
          <div className="flex flex-col gap-2">
            {stages.regions.map((region) => (
              <ConflictRegionBlock
                key={region.id}
                region={region}
                showBase={stages.ancestor !== null}
                selected={resolution.regions.get(region.id) ?? null}
                onTake={(take: RegionTake) => resolution.selectRegion(region.id, take)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default React.memo(ConflictView);
