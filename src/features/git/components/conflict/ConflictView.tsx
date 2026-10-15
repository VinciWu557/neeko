import React, { useCallback } from 'react';

import { openProjectFile } from '@/features/quick-open';
import type { ConflictKind, ConflictStages } from '@/shared/types';
import type { ProjectCommands } from '@/shared/types/activeProject';
import type { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { useConflictStages } from '../../hooks/useConflictStages';

import ConflictOpaqueCard from './ConflictOpaqueCard';
import ConflictRegionBlock from './ConflictRegionBlock';
import ConflictSidePanel from './ConflictSidePanel';
import ConflictToolbar from './ConflictToolbar';

interface ConflictViewProps {
  /** 地址权威（红线 12）：冲突读命令按此Workspace寻址。 */
  workspace: WorkspaceSession;
  filePath: string;
  commands?: ProjectCommands | null;
  onBack?: () => void;
}

function missingHintFor(side: 'base' | 'ours' | 'theirs', kind: ConflictKind): string {
  if (side === 'ours') return '（我方已删除）';
  if (side === 'theirs') return '（对方已删除）';
  return kind === 'both_added' ? '（无共同祖先）' : '（无 base）';
}

/**
 * 冲突文件的**只读**三侧视图（`DiffView` 的兄弟，不是改造它）。
 *
 * 真值来自后端 `get_conflict_stages`（index unmerged stages），**不解析工作区 marker**
 * （护栏 A4）。本层只交付：三侧内容 + 区域列表 + 「在编辑器打开」逃生门 + 截断提示；
 * 决议交互（整文件 / 区域）由 Layer 2 子任务承接。
 */
const ConflictView: React.FC<ConflictViewProps> = ({ workspace, filePath, commands, onBack }) => {
  const { stages, loading, error, notConflicted } = useConflictStages({
    commands,
    workspace,
    filePath,
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
    />
  );
};

interface ConflictViewBodyProps {
  stages: ConflictStages;
  fileName: string;
  filePath: string;
  regionMergeable: boolean;
  onOpenFile: () => void;
}

const ConflictViewBody: React.FC<ConflictViewBodyProps> = ({
  stages,
  fileName,
  filePath,
  regionMergeable,
  onOpenFile,
}) => (
  <div className="flex h-full min-w-0 flex-col overflow-hidden bg-bg-secondary">
    <ConflictToolbar
      fileName={fileName}
      filePath={filePath}
      kind={stages.kind}
      regionCount={stages.regions.length}
      truncated={stages.truncated}
      onOpenFile={onOpenFile}
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
            />
          ))}
        </div>
      ) : null}
    </div>
  </div>
);

export default React.memo(ConflictView);
