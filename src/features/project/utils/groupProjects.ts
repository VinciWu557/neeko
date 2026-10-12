import type { Project } from '@/shared/types';
import type { RemoteEntrySession } from '@/shared/types/connection';

/** WSL 分组：按发行版聚合；Remote 分组：按连接条目聚合。 */
export interface GroupedProjects {
  localProjects: Project[];
  wslGroups: Array<{ distro: string; projects: Project[] }>;
  remoteGroups: Array<{ entry: RemoteEntrySession; projects: Project[] }>;
  /** 全部区段中「最后一个项目」所属区段（DnD 排序落点用）。 */
  lastGroup: 'local' | 'wsl' | 'remote' | null;
  lastProjectId: string | null;
}

/**
 * 把项目列表按环境（Local / WSL 按 distro / Remote 按连接条目）分组的唯一实现。
 * 从 ProjectsPanel 的 useMemo 主体抽出（组件体积 ratchet / 纯逻辑可测），行为零漂移：
 * Remote 项目只有命中已保存的连接条目才入组，否则丢弃。
 */
export function groupProjects(
  projects: Project[],
  remoteEntries: RemoteEntrySession[],
): GroupedProjects {
  const local: Project[] = [];
  const wslMap = new Map<string, Project[]>();
  const remoteMap = new Map<string, { entry: RemoteEntrySession; projects: Project[] }>();

  for (const p of projects) {
    const env = p.environment;
    if (env.type === 'Wsl') {
      const group = wslMap.get(env.distro) ?? [];
      group.push(p);
      wslMap.set(env.distro, group);
    } else if (env.type === 'Remote') {
      const entry = remoteEntries.find((e) => e.host === env.host);
      if (entry) {
        const existing = remoteMap.get(entry.id) ?? { entry, projects: [] };
        existing.projects.push(p);
        remoteMap.set(entry.id, existing);
      }
    } else {
      local.push(p);
    }
  }

  const wslGroups = Array.from(wslMap.entries()).map(([distro, group]) => ({
    distro,
    projects: group,
  }));
  const remoteGroups = Array.from(remoteMap.values());

  // Determine which group has the last project across all sections
  let lastGroup: GroupedProjects['lastGroup'] = null;
  let lastProjectId: string | null = null;
  if (local.length > 0) {
    lastGroup = 'local';
    lastProjectId = local[local.length - 1].id;
  }
  for (const g of wslGroups) {
    if (g.projects.length > 0) {
      lastGroup = 'wsl';
      lastProjectId = g.projects[g.projects.length - 1].id;
    }
  }
  for (const g of remoteGroups) {
    if (g.projects.length > 0) {
      lastGroup = 'remote';
      lastProjectId = g.projects[g.projects.length - 1].id;
    }
  }

  return { localProjects: local, wslGroups, remoteGroups, lastGroup, lastProjectId };
}
