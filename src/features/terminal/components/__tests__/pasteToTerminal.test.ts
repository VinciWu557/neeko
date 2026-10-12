// @vitest-environment node
import { emit } from '@tauri-apps/api/event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '@/shared/store/projectStore';
import type { Project } from '@/shared/types';
import { terminalInputEvent } from '@/shared/utils/terminalEvents';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

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

import { terminalAddress, terminalCache } from '../terminalCache';
import { pasteToTerminal, wrapBracketedPaste } from '../terminalCommands';

const mockEmit = vi.mocked(emit);

const START = '\x1b[200~';
const END = '\x1b[201~';

const session = WorkspaceSession.of('proj1', null);

function makeEntry(sessionId: string | null): never {
  return { sessionId, term: { dispose: vi.fn() } } as never;
}

describe('pasteToTerminal', () => {
  beforeEach(() => {
    terminalCache.clear();
    mockEmit.mockClear();
    useProjectStore.setState({
      projects: [{ id: 'proj1', environment: { type: 'Local' } } as unknown as Project],
      activeProject: null,
    });
  });

  it('bracketed 包裹：首尾标记夹住原文', () => {
    expect(wrapBracketedPaste('hi')).toBe(`${START}hi${END}`);
  });

  it('命中会话时整段 emit bracketed 字节并返回 true', () => {
    terminalCache.set(terminalAddress(session, 'tabA'), makeEntry('s1'));
    expect(pasteToTerminal(session, 'echo hi', 'tabA')).toBe(true);
    const expected = Array.from(new TextEncoder().encode(`${START}echo hi${END}`));
    expect(mockEmit).toHaveBeenCalledWith(terminalInputEvent('s1'), expected);
  });

  it('无匹配会话时不 emit 并返回 false', () => {
    expect(pasteToTerminal(session, 'hi', 'missing')).toBe(false);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('不传 tabId 时落到该 session 首个终端', () => {
    terminalCache.set(terminalAddress(session, 'tabA'), makeEntry('s-first'));
    expect(pasteToTerminal(session, 'hi')).toBe(true);
    expect(mockEmit).toHaveBeenCalledWith(terminalInputEvent('s-first'), expect.anything());
  });

  it('多行 content 整段进入缓冲：不补回车，零行被执行', () => {
    terminalCache.set(terminalAddress(session, 'tabA'), makeEntry('s1'));
    pasteToTerminal(session, 'line1\nline2', 'tabA');
    const bytes: number[] = mockEmit.mock.calls[0][1] as number[];
    const text = new TextDecoder().decode(new Uint8Array(bytes));
    expect(text).toBe(`${START}line1\nline2${END}`);
    expect(text.endsWith('\r')).toBe(false);
  });
});
