// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { closeTabMock, clearProjectTabsMock } = vi.hoisted(() => ({
  closeTabMock: vi.fn(),
  clearProjectTabsMock: vi.fn(),
}));

vi.mock('../../api/terminalApi', () => ({
  closeTerminalSession: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn(),
}));

vi.mock('../../../agent/api/agentApi', () => ({
  getAgent: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/shared/store/editorStore', () => ({
  useEditorStore: {
    getState: () => ({
      closeTab: closeTabMock,
      clearProjectTabs: clearProjectTabsMock,
      tabs: {
        'proj-1\u0000': {
          tabs: [
            { id: 'tab_a', data: { kind: 'terminal' } },
            { id: 'tab_b', data: { kind: 'file' } },
          ],
          activeTabId: 'tab_a',
        },
      },
    }),
  },
}));

import { useProjectStore } from '@/shared/store/projectStore';
import type { Project } from '@/shared/types';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { terminalAddress } from '../terminalAddress';
import { terminalCache } from '../terminalCache';
import {
  cleanupTerminalsForTab,
  cleanupTerminalsForTabKey,
  closeAllEditorTabs,
  closeEditorTab,
} from '../terminalTabCleanup';

function makeEntry(sessionId: string | null): never {
  return {
    sessionId,
    term: { dispose: vi.fn() },
    unlisten: null,
    unlistenOutput: null,
    unlistenClosed: null,
    inputController: null,
  } as never;
}

const main = WorkspaceSession.of('proj-1', null);
const wt = WorkspaceSession.of('proj-1', '/wt');

describe('terminalTabCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalCache.clear();
    useProjectStore.setState({
      projects: [{ id: 'proj-1', environment: { type: 'Local' } } as unknown as Project],
      activeProject: null,
    });
  });

  it('cleanupTerminalsForTab 只销毁该 tab 的键（含多 pane），不动同 session 其它 tab', () => {
    terminalCache.set(terminalAddress(main, 'tab_a', 'p1'), makeEntry('s1'));
    terminalCache.set(terminalAddress(main, 'tab_a', 'p2'), makeEntry('s2'));
    terminalCache.set(terminalAddress(main, 'tab_b', 'p1'), makeEntry('s3'));

    cleanupTerminalsForTab(main.key, 'tab_a');

    expect(terminalCache.has(terminalAddress(main, 'tab_a', 'p1'))).toBe(false);
    expect(terminalCache.has(terminalAddress(main, 'tab_a', 'p2'))).toBe(false);
    expect(terminalCache.has(terminalAddress(main, 'tab_b', 'p1'))).toBe(true);
  });

  it('cleanupTerminalsForTabKey 只销毁该 workspace 单元（worktree 不波及其它单元）', () => {
    terminalCache.set(terminalAddress(wt, 'tab_a', 'p1'), makeEntry('s-wt'));
    terminalCache.set(terminalAddress(main, 'tab_a', 'p1'), makeEntry('s-main'));

    cleanupTerminalsForTabKey(wt.key);

    expect(terminalCache.has(terminalAddress(wt, 'tab_a', 'p1'))).toBe(false);
    expect(terminalCache.has(terminalAddress(main, 'tab_a', 'p1'))).toBe(true);
  });

  it('closeEditorTab 先清缓存再关 tab', () => {
    terminalCache.set(terminalAddress(main, 'tab_a', 'p1'), makeEntry('s1'));

    closeEditorTab(main.key, 'tab_a');

    expect(terminalCache.has(terminalAddress(main, 'tab_a', 'p1'))).toBe(false);
    expect(closeTabMock).toHaveBeenCalledWith(main.key, 'tab_a');
  });

  it('closeAllEditorTabs 清理每个 terminal tab 并 clearProjectTabs', () => {
    terminalCache.set(terminalAddress(main, 'tab_a', 'p1'), makeEntry('s1'));

    closeAllEditorTabs(main.key);

    expect(terminalCache.has(terminalAddress(main, 'tab_a', 'p1'))).toBe(false);
    expect(clearProjectTabsMock).toHaveBeenCalledWith(main.key);
  });
});
