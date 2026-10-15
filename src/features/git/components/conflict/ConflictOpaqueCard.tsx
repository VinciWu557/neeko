import React from 'react';

import type { ConflictKind, ConflictStages } from '@/shared/types';

interface ConflictOpaqueCardProps {
  stages: ConflictStages;
}

/**
 * 不可区域合并（`binary` / `rename_rename` / `modify_delete`）的状态卡。
 *
 * 这三类**没有**「双方都有实体内容」的前提，区域行区间无意义（`design.md` §0.1）：
 * - `modify_delete`：删除不是内容，只给整文件二选一；
 * - `binary`：不解码内容，只给状态；
 * - `rename_rename`：三侧路径不同。
 *
 * 因此**不渲染区域列表**，只展示三侧存在性 + 说明。
 *
 * 文案表对 `ConflictKind` **穷尽 switch、无 `default:`**（同目录 `ConflictToolbar.kindLabel`
 * 的写法）：新增一个 kind 时这里直接编译不过，而不是静默落到「modify/delete」的兜底文案
 * （把 binary 冲突说成「一方删除了文件」是假信息）。`both_modified` / `both_added` 两支在
 * 正常渲染下不可达（`ConflictView` 按 `region_mergeable` 守卫），但仍给出诚实文案 ——
 * 万一守卫失效，用户看到的是真相而不是错判的冲突类型。
 */
function copyFor(kind: ConflictKind): { header: string; body: string } {
  switch (kind) {
    case 'modify_delete':
      return {
        header: 'Modify/delete conflict — whole-file choice',
        body: 'One side deleted this file — resolving keeps either the remaining version or the deletion (no region-level merge).',
      };
    case 'binary':
      return {
        header: 'Binary conflict — not text-mergeable',
        body: 'Binary content is not decoded — choose one side as a whole (no region-level merge).',
      };
    case 'rename_rename':
      return {
        header: 'Rename/rename conflict — not region-mergeable',
        body: 'Both sides renamed this file to different paths — no region-level merge.',
      };
    case 'both_modified':
    case 'both_added':
      return {
        header: 'Region-mergeable conflict',
        body: 'This conflict supports region-level merge — see the region list below.',
      };
  }
}

const ConflictOpaqueCard: React.FC<ConflictOpaqueCardProps> = ({ stages }) => {
  const { header, body } = copyFor(stages.kind);

  const sideStatus = (label: string, side: ConflictStages['ours']) => (
    <div className="flex items-center gap-2 text-[calc(var(--font-size)-1px)]">
      <span className="w-14 font-semibold text-text-muted">{label}</span>
      {side === null ? (
        <span className="italic text-text-muted">（已删除）</span>
      ) : (
        <span className="font-mono text-text-primary">{side.path}</span>
      )}
    </div>
  );

  return (
    <div className="rounded border border-border/50 bg-bg-secondary">
      <div className="border-b border-border/40 bg-bg-tertiary/40 px-2 py-1 text-[calc(var(--font-size)-2px)] font-semibold text-accent-yellow">
        {header}
      </div>
      <div className="flex flex-col gap-1 p-2">
        <p className="text-[calc(var(--font-size)-1px)] text-text-muted">{body}</p>
        {sideStatus('Base', stages.ancestor)}
        {sideStatus('Ours', stages.ours)}
        {sideStatus('Theirs', stages.theirs)}
      </div>
    </div>
  );
};

export default React.memo(ConflictOpaqueCard);
