import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { closeSessionMock, getAgentMock } = vi.hoisted(() => ({
  closeSessionMock: vi.fn().mockResolvedValue(undefined),
  getAgentMock: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../api/terminalApi', () => ({
  closeTerminalSession: closeSessionMock,
}));

vi.mock('../../../agent/api/agentApi', () => ({
  getAgent: getAgentMock,
}));

import { useProjectStore } from '@/shared/store/projectStore';
import type { Project } from '@/shared/types';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { terminalAddress } from '../terminalAddress';
import {
  switchAgentInSessionTerminal,
  wslRebuildCallbacks,
  wslTerminalCache,
  wslWrapperRefs,
} from '../terminalCache';

function makeTerm(): Terminal {
  return { dispose: vi.fn() } as unknown as Terminal;
}

const session = WorkspaceSession.of('proj1', null);

describe('switchAgentInSessionTerminal', () => {
  const key = terminalAddress(session, 'tab1');
  let wrapper: HTMLDivElement;

  beforeEach(() => {
    wrapper = document.createElement('div');
    wslWrapperRefs.set(key, wrapper);
    useProjectStore.setState({
      projects: [
        {
          id: 'proj1',
          environment: { type: 'Wsl', distro: 'Ubuntu' },
        } as unknown as Project,
      ],
      activeProject: null,
    });
  });

  afterEach(() => {
    wslTerminalCache.clear();
    wslRebuildCallbacks.clear();
    wslWrapperRefs.clear();
    useProjectStore.setState({ projects: [], activeProject: null });
    closeSessionMock.mockClear();
  });

  it('切换 agent 时卸载旧终端的 output/closed 事件监听器并回收 PTY', async () => {
    const unlistenOutput = vi.fn();
    const unlistenClosed = vi.fn();
    const rebuild = vi.fn();
    const term = makeTerm();
    wslTerminalCache.set(key, {
      term,
      fitAddon: {} as FitAddon,
      element: document.createElement('div'),
      sessionId: 's1',
      unlisten: null,
      unlistenOutput,
      unlistenClosed,
      inputController: { dispose: vi.fn() } as never,
    });
    wslRebuildCallbacks.set(key, rebuild);

    await switchAgentInSessionTerminal(session, 'tab1', 'agent1');

    expect(unlistenOutput).toHaveBeenCalled();
    expect(unlistenClosed).toHaveBeenCalled();
    expect(term.dispose).toHaveBeenCalled();
    expect(closeSessionMock).toHaveBeenCalledWith('s1');
    expect(wslTerminalCache.has(key)).toBe(false);
    expect(rebuild).toHaveBeenCalled();
  });
});
