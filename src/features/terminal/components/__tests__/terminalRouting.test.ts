// @vitest-environment node
import { emit } from '@tauri-apps/api/event';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { useProjectStore } from '@/shared/store/projectStore';
import type { Project, Tab, TabScope } from '@/shared/types';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { terminalAddress, terminalCache } from '../terminalCache';
import { foregroundTerminalTab, insertToSessionTerminal } from '../terminalRouting';

const mockEmit = vi.mocked(emit);

function tab(id: string, order: number, kind: 'terminal' | 'file', session: WorkspaceSession): Tab {
  const scope: TabScope = { kind: 'workspace', session };
  return {
    id,
    scope,
    title: `${kind}-${id}`,
    order,
    data: (kind === 'terminal' ? { kind: 'terminal' } : { kind: 'file', filePath: id }) as never,
  };
}

function setTabs(tabKey: string, tabs: Tab[], activeTabId: string | null): void {
  useEditorStore.setState((state) => ({
    tabs: { ...state.tabs, [tabKey]: { tabs, activeTabId } },
  }));
}

function makeEntry(sessionId: string | null): never {
  return { sessionId, term: { dispose: vi.fn() } } as never;
}

afterEach(() => {
  terminalCache.clear();
  useEditorStore.setState({ tabs: {} });
  useProjectStore.setState({ projects: [], activeProject: null });
  mockEmit.mockClear();
});

describe('foregroundTerminalTab', () => {
  const session = WorkspaceSession.of('proj1', null);

  it('前台是 terminal → isFallback=false', () => {
    setTabs(
      session.key,
      [tab('t1', 0, 'terminal', session), tab('t2', 1, 'terminal', session)],
      't2',
    );
    const target = foregroundTerminalTab(session);
    expect(target?.tab.id).toBe('t2');
    expect(target?.isFallback).toBe(false);
  });

  it('前台非 terminal → fallback 同 session 首个 terminal（按 order）', () => {
    setTabs(
      session.key,
      [
        tab('f1', 0, 'file', session),
        tab('t2', 2, 'terminal', session),
        tab('t1', 1, 'terminal', session),
      ],
      'f1',
    );
    const target = foregroundTerminalTab(session);
    expect(target?.tab.id).toBe('t1');
    expect(target?.isFallback).toBe(true);
  });

  it('无 terminal → null', () => {
    setTabs(session.key, [tab('f1', 0, 'file', session)], 'f1');
    expect(foregroundTerminalTab(session)).toBeNull();
  });

  it('无 tab 空间 → null', () => {
    useEditorStore.setState({ tabs: {} });
    expect(foregroundTerminalTab(session)).toBeNull();
  });

  it('多 session 隔离：不串到另一个 workspace 空间', () => {
    const wt = WorkspaceSession.of('proj1', '/wt/a');
    setTabs(session.key, [tab('main-t', 0, 'terminal', session)], 'main-t');
    setTabs(wt.key, [tab('wt-t', 0, 'terminal', wt)], 'wt-t');
    expect(foregroundTerminalTab(session)?.tab.id).toBe('main-t');
    expect(foregroundTerminalTab(wt)?.tab.id).toBe('wt-t');
  });
});

describe('insertToSessionTerminal', () => {
  const session = WorkspaceSession.of('proj1', null);

  function givenLocalProject(): void {
    useProjectStore.setState({
      projects: [{ id: 'proj1', environment: { type: 'Local' } } as unknown as Project],
      activeProject: null,
    });
  }

  it('命中前台 terminal：emit bracketed-paste，返回落点', () => {
    givenLocalProject();
    setTabs(session.key, [tab('t1', 0, 'terminal', session)], 't1');
    terminalCache.set(terminalAddress(session, 't1'), makeEntry('s1'));

    const result = insertToSessionTerminal(session, 'hello');
    expect(result).toEqual({ ok: true, landedTabTitle: 'terminal-t1', isFallback: false });
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const bytes = mockEmit.mock.calls[0][1] as number[];
    expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe('\x1b[200~hello\x1b[201~');
  });

  it('fallback 命中首个 terminal：isFallback=true 且落在该 tab 的 PTY', () => {
    givenLocalProject();
    setTabs(session.key, [tab('f1', 0, 'file', session), tab('t1', 1, 'terminal', session)], 'f1');
    terminalCache.set(terminalAddress(session, 't1'), makeEntry('s-fallback'));

    const result = insertToSessionTerminal(session, 'hi');
    expect(result.ok).toBe(true);
    expect(result.isFallback).toBe(true);
    expect(result.landedTabTitle).toBe('terminal-t1');
  });

  it('session 内无终端 → 显式失败且不 emit', () => {
    givenLocalProject();
    setTabs(session.key, [tab('f1', 0, 'file', session)], 'f1');
    expect(insertToSessionTerminal(session, 'hi')).toEqual({ ok: false });
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('tab 在但 PTY 未就绪 → 失败且不 emit', () => {
    givenLocalProject();
    setTabs(session.key, [tab('t1', 0, 'terminal', session)], 't1');
    terminalCache.set(terminalAddress(session, 't1'), makeEntry(null));
    expect(insertToSessionTerminal(session, 'hi')).toEqual({ ok: false });
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('跨 session 隔离：只插当前 session', () => {
    givenLocalProject();
    const wt = WorkspaceSession.of('proj1', '/wt/a');
    setTabs(session.key, [tab('t1', 0, 'terminal', session)], 't1');
    terminalCache.set(terminalAddress(session, 't1'), makeEntry('s-main'));
    terminalCache.set(terminalAddress(wt, 'wt-t'), makeEntry('s-wt'));

    expect(insertToSessionTerminal(session, 'x').ok).toBe(true);
    expect(mockEmit.mock.calls[0][0]).toBe('terminal-input-s-main');
  });
});
