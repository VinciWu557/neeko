import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { closeSessionMock, getAgentMock } = vi.hoisted(() => ({
  closeSessionMock: vi.fn().mockResolvedValue(undefined),
  getAgentMock: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../api/terminalApi', () => ({
  closeTerminalSession: closeSessionMock,
  resizeTerminal: vi.fn(),
}));

vi.mock('../../../agent/api/agentApi', () => ({
  getAgent: getAgentMock,
}));

import { useEditorStore } from '@/shared/store/editorStore';
import type { TerminalTabData } from '@/shared/types';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { switchAgentInTerminal } from '../terminalAgentSwitch';
import {
  terminalAddress,
  terminalCache,
  terminalRebuildCallbacks,
  terminalWrapperRefs,
} from '../terminalCache';

const session = WorkspaceSession.of('proj1', null);
const key = terminalAddress(session, 'tab1');

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

function seedTab(): void {
  useEditorStore.setState({
    tabs: {
      [session.key]: {
        tabs: [
          {
            id: 'tab1',
            scope: { kind: 'workspace', session },
            title: 'Terminal',
            order: 0,
            data: { kind: 'terminal', agentId: null, status: 'Idle' },
          },
        ],
        activeTabId: 'tab1',
      } as never,
    },
  });
}

function tabAgentId(): string | null {
  const data = useEditorStore.getState().tabs[session.key].tabs[0].data as TerminalTabData;
  return data.agentId;
}

describe('switchAgentInTerminal（唯一 env-blind 能力）', () => {
  beforeEach(() => {
    seedTab();
    closeSessionMock.mockClear();
  });

  afterEach(() => {
    terminalCache.clear();
    terminalWrapperRefs.clear();
    terminalRebuildCallbacks.clear();
    useEditorStore.setState({ tabs: {} });
  });

  it('目标 agent 落到 tab 身份，并委托底层清 PTY + 触发重建', async () => {
    terminalCache.set(key, makeEntry('s1'));
    terminalWrapperRefs.set(key, document.createElement('div'));
    const rebuild = vi.fn();
    terminalRebuildCallbacks.set(key, rebuild);

    await switchAgentInTerminal(session, 'tab1', 'agentX');

    expect(tabAgentId()).toBe('agentX');
    expect(terminalCache.has(key)).toBe(false);
    expect(rebuild).toHaveBeenCalled();
    expect(closeSessionMock).toHaveBeenCalledWith('s1');
  });

  it('tabId=null 时按 session 首个终端派生 tab 身份', async () => {
    terminalCache.set(key, makeEntry('s1'));
    terminalWrapperRefs.set(key, document.createElement('div'));

    await switchAgentInTerminal(session, null, 'agentX');

    expect(tabAgentId()).toBe('agentX');
  });

  it('session 内无终端 → 空转（不写 tab、不抛错）', async () => {
    await expect(switchAgentInTerminal(session, null, 'agentX')).resolves.toBeUndefined();
    expect(tabAgentId()).toBeNull();
  });
});
