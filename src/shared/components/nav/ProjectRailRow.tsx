import React from 'react';

import { cn } from '@/lib/utils';
import type { Project } from '@/shared/types';
import { getAvatarStyle, getProjectInitials } from '@/shared/utils/projectAvatar';
import type { ProjectId } from '@/shared/utils/workspaceRef';

import CountLabel from './CountLabel';
import NavRow from './NavRow';

interface ProjectRailRowProps {
  project: Project;
  active: boolean;
  /** 磁盘上的 skill 数（未加载为 undefined）。 */
  diskCount: number | undefined;
  /** 绑定的 tag group 数（未加载为 undefined）。 */
  groupCount: number | undefined;
  diskLoading: boolean;
  groupLoading: boolean;
  skillError: string | null;
  tagGroupError: string | null;
  /**
   * testId 前缀 —— 四个 testId 的**唯一铸造点**（消费方不得自行拼接）：
   * `${prefix}row-${id}` / `${prefix}metrics-${id}` /
   * `${prefix}disk-count-${id}` / `${prefix}group-count-${id}`。
   */
  testIdPrefix: string;
  /** 选中该行（回传项目 id —— 消费方直传稳定回调，行 memo 才有意义）。 */
  onSelect: (projectId: ProjectId) => void;
}

/**
 * 左栏 project 行（Skills 面板与 MCP 导航面板共用）—— 双指标：磁盘 skill 数 · 绑定 tag group 数。
 *
 * 合并前两侧呈现不同（MCP 侧：16px 圆形头像 / 无 `Ng` 后缀 / 无错误聚合 / 无 tooltip+aria）；
 * 本组件统一取 Skills 的富变体 —— 与 `CountLabel` 注释确立的 canonical 方向一致
 * （「统一到更丰富的 Skills 变体」），MCP 侧自此与 Skills 侧同步演进。
 */
const ProjectRailRow: React.FC<ProjectRailRowProps> = React.memo(
  ({
    project,
    active,
    diskCount,
    groupCount,
    diskLoading,
    groupLoading,
    skillError,
    tagGroupError,
    testIdPrefix,
    onSelect,
  }) => {
    const hasError = Boolean(skillError || tagGroupError);
    const diskNum = diskCount ?? 0;
    const groupNum = groupCount ?? 0;
    const diskLabel = hasError
      ? '!'
      : diskLoading && diskCount === undefined
        ? '…'
        : String(diskNum);
    const groupLabel = hasError
      ? '!'
      : groupLoading && groupCount === undefined
        ? '…'
        : `${groupNum}g`;
    const metricsTitle = hasError
      ? (skillError ?? tagGroupError ?? undefined)
      : `${diskNum} skill${diskNum === 1 ? '' : 's'} on disk · ${groupNum} tag group${groupNum === 1 ? '' : 's'} bound`;

    return (
      <NavRow
        active={active}
        gapClassName="gap-2.5"
        onSelect={() => onSelect(project.id)}
        title={metricsTitle}
        testId={`${testIdPrefix}row-${project.id}`}
        leading={
          <span
            className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold shrink-0"
            style={getAvatarStyle({ name: project.name, color: project.avatar_color })}
          >
            {getProjectInitials(project.name)}
          </span>
        }
      >
        <span className="truncate flex-1 font-medium">{project.name}</span>
        <span
          className={cn(
            'inline-flex items-baseline gap-1 text-[11px] tabular-nums shrink-0',
            hasError ? 'text-accent-red' : 'text-text-muted',
          )}
          data-testid={`${testIdPrefix}metrics-${project.id}`}
          aria-label={`${diskLabel} on disk, ${groupLabel} bound`}
        >
          <CountLabel
            loading={diskLoading}
            error={skillError}
            count={diskCount}
            testId={`${testIdPrefix}disk-count-${project.id}`}
          />
          <span className="opacity-40" aria-hidden>
            ·
          </span>
          <span
            className={cn(active && !tagGroupError && 'text-accent-blue/90')}
            data-testid={`${testIdPrefix}group-count-${project.id}`}
          >
            <CountLabel
              loading={groupLoading}
              error={tagGroupError}
              count={groupCount}
              format={(n) => `${n}g`}
            />
          </span>
        </span>
      </NavRow>
    );
  },
);

ProjectRailRow.displayName = 'ProjectRailRow';

export default ProjectRailRow;
