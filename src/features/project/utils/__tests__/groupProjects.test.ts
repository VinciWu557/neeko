// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { RemoteEntrySession } from '@/shared/types/connection';
import type { ProjectId } from '@/shared/utils/workspaceRef';
import { createProject } from '@/testing/factories';

import { groupProjects } from '../groupProjects';

function remoteEntry(overrides: Partial<RemoteEntrySession> = {}): RemoteEntrySession {
  return {
    id: 'entry-1',
    host: 'build.example.com',
    port: 22,
    username: 'dev',
    projects: [],
    ...overrides,
  };
}

const wsl = (id: string, distro: string) =>
  createProject({ id: id as ProjectId, name: id, environment: { type: 'Wsl', distro } });

const remote = (id: string, host: string) =>
  createProject({
    id: id as ProjectId,
    name: id,
    environment: { type: 'Remote', host, port: 22, username: 'dev', auth: { Password: 'x' } },
  });

describe('groupProjects', () => {
  it('全部 Local：保持顺序', () => {
    const local1 = createProject({ id: 'p1' as ProjectId, name: 'one' });
    const local2 = createProject({ id: 'p2' as ProjectId, name: 'two' });

    const result = groupProjects([local1, local2], []);

    expect(result.localProjects.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(result.wslGroups).toEqual([]);
    expect(result.remoteGroups).toEqual([]);
  });

  it('WSL 按 distro 聚合', () => {
    const result = groupProjects(
      [wsl('a', 'Ubuntu'), wsl('b', 'Ubuntu'), wsl('c', 'Debian'), wsl('d', 'Arch')],
      [],
    );

    expect(result.wslGroups.map((g) => [g.distro, g.projects.length])).toEqual([
      ['Ubuntu', 2],
      ['Debian', 1],
      ['Arch', 1],
    ]);
    expect(result.localProjects).toEqual([]);
  });

  it('Remote 只有命中已保存连接条目才入组（未知 host 丢弃）', () => {
    const result = groupProjects(
      [remote('r1', 'build.example.com'), remote('r2', 'unknown.host')],
      [remoteEntry()],
    );

    expect(result.remoteGroups).toHaveLength(1);
    expect(result.remoteGroups[0].entry.id).toBe('entry-1');
    expect(result.remoteGroups[0].projects.map((p) => p.id)).toEqual(['r1']);
  });

  it('混合区段：三个区段各自独立聚合，互不吞并', () => {
    const local = createProject({ id: 'l1' as ProjectId, name: 'local' });
    const wslProject = wsl('w1', 'Ubuntu');
    const remoteProject = remote('r1', 'build.example.com');

    const withRemote = groupProjects([local, wslProject, remoteProject], [remoteEntry()]);
    expect(withRemote.localProjects.map((p) => p.id)).toEqual(['l1']);
    expect(withRemote.wslGroups.map((g) => g.distro)).toEqual(['Ubuntu']);
    expect(withRemote.remoteGroups).toHaveLength(1);

    // 无成功入组的 remote 时落回空区段（不污染 wsl）
    const withoutRemote = groupProjects([local, wslProject, remoteProject], []);
    expect(withoutRemote.localProjects.map((p) => p.id)).toEqual(['l1']);
    expect(withoutRemote.wslGroups.map((g) => g.distro)).toEqual(['Ubuntu']);
    expect(withoutRemote.remoteGroups).toEqual([]);
  });
});
