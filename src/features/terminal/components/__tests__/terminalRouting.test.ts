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

import {
  insertAgentInput,
  registerAgentInput,
  unregisterAgentInput,
} from '@/features/agent-chat/api/agentInputRegistry';
import { insertToSessionAgent } from '@/features/agent-chat/api/insertToSessionAgent';
import { useEditorStore } from '@/shared/store/editorStore';
import { useProjectStore } from '@/shared/store/projectStore';
import type { Project, Tab, TabScope } from '@/shared/types';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { terminalAddress } from '../terminalAddress';
import { terminalCache } from '../terminalCache';
import {
  foregroundAgentCliTab,
  foregroundTerminalTab,
  insertToSessionTerminal,
} from '../terminalRouting';

const mockEmit = vi.mocked(emit);

function tab(
  id: string,
  order: number,
  kind: 'terminal' | 'file',
  session: WorkspaceSession,
  /**
   * terminal kind 的 agentId。**默认 null（普通终端）** —— 缺省成 `undefined` 会让
   * `agentId !== null` 成立，普通终端被误判为 Agent CLI tab（假绿）。
   */
  agentId: string | null = null,
): Tab {
  const scope: TabScope = { kind: 'workspace', session };
  const data =
    kind === 'terminal'
      ? { kind: 'terminal', agentId, status: 'Idle' }
      : { kind: 'file', filePath: id };
  return {
    id,
    scope,
    title: `${kind}-${id}`,
    order,
    data: data as never,
  };
}

/** agent-chat kind 的夹具（composer 投递目标）。 */
function chatTab(id: string, order: number, session: WorkspaceSession): Tab {
  return {
    id,
    scope: { kind: 'workspace', session },
    title: `chat-${id}`,
    order,
    data: { kind: 'agent-chat', agentId: 'opencode' } as never,
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

/**
 * composer 挂载的夹具：走**真 registry**，不 mock。
 *
 * registry 是被测编排的协作方，不是外部边界（Tauri API 才是）；mock 掉它会让
 * 「编排 + 接收端」的接线本身失去覆盖（mock-strategies.md 常见错误 1）。
 */
const mounted: Array<[WorkspaceSession, string]> = [];

function mountComposer(session: WorkspaceSession, tabId: string, accepts = true): void {
  mounted.push([session, tabId]);
  registerAgentInput(session, tabId, () => accepts);
}

afterEach(() => {
  for (const [session, tabId] of mounted.splice(0)) unregisterAgentInput(session, tabId);
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

  it('前台是终端 → 取前台（即使它 order 不是最小）', () => {
    setTabs(
      session.key,
      [tab('t1', 0, 'terminal', session), tab('t2', 1, 'terminal', session)],
      't2',
    );
    const target = foregroundTerminalTab(session);
    expect(target?.tab.id).toBe('t2');
    expect(target?.isFallback).toBe(false);
  });
});

/**
 * 决议 Q2 的可执行形式：「要 Agent CLI tab」是在**同一个 order 升序序列**上过滤，
 * 不是第二套顺序口径。旧实现（`pickerUtils.findAgentCliTab`）取 order **降序**首个
 * （最近新增优先）—— 本组用例就是钉住它已统一到升序。
 */
describe('foregroundAgentCliTab（Q2：与终端仲裁同序）', () => {
  const session = WorkspaceSession.of('proj1', null);

  it('多个 Agent CLI tab且无前台 → 取 order **升序**首个（旧实现取降序 = 本用例在旧口径上必红）', () => {
    setTabs(
      session.key,
      [
        tab('t-old', 0, 'terminal', session, 'claude'),
        tab('t-new', 3, 'terminal', session, 'claude'),
      ],
      null,
    );
    const target = foregroundAgentCliTab(session);
    expect(target?.tab.id).toBe('t-old');
    expect(target?.isFallback).toBe(true);
  });

  it('前台就是 Agent CLI → 取前台', () => {
    setTabs(
      session.key,
      [tab('t1', 0, 'terminal', session, 'claude'), tab('t2', 1, 'terminal', session, 'codex')],
      't2',
    );
    expect(foregroundAgentCliTab(session)?.tab.id).toBe('t2');
    expect(foregroundAgentCliTab(session)?.isFallback).toBe(false);
  });

  it('agentId === null 的普通终端不算 Agent CLI', () => {
    setTabs(session.key, [tab('t-plain', 0, 'terminal', session)], 't-plain');
    expect(foregroundAgentCliTab(session)).toBeNull();
  });

  it('与 terminal 仲裁同序：同一序列、只是多一层类型筛选', () => {
    setTabs(
      session.key,
      [
        tab('t-plain', 0, 'terminal', session, null),
        tab('t-agent', 1, 'terminal', session, 'claude'),
        tab('t-agent2', 2, 'terminal', session, 'codex'),
      ],
      null,
    );
    // terminal 仲裁给 t-plain（首个终端），agent 仲裁给 t-agent（首个**带 agent** 的终端）：
    // 两者都是从同一个 order 升序序列取首个命中，不存在「一个升序一个降序」。
    expect(foregroundTerminalTab(session)?.tab.id).toBe('t-plain');
    expect(foregroundAgentCliTab(session)?.tab.id).toBe('t-agent');
  });

  it('跨 session 不串', () => {
    const wt = WorkspaceSession.of('proj1', '/wt/a');
    setTabs(session.key, [tab('main-agent', 0, 'terminal', session, 'claude')], null);
    setTabs(wt.key, [tab('wt-agent', 0, 'terminal', wt, 'claude')], null);
    expect(foregroundAgentCliTab(session)?.tab.id).toBe('main-agent');
    expect(foregroundAgentCliTab(wt)?.tab.id).toBe('wt-agent');
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

/**
 * insertToSessionAgent 的夹具：Q1 的优先链 + Q5 的显式成败。
 */
describe('insertToSessionAgent（Q1 composer 优先 → Agent CLI 降级 → 显式 false）', () => {
  const session = WorkspaceSession.of('proj1', null);

  it('composer 已挂载 → 落 composer，**不往 PTY emit**', () => {
    setTabs(session.key, [chatTab('c1', 0, session), tab('t1', 1, 'terminal', session)], 't1');
    terminalCache.set(terminalAddress(session, 't1'), makeEntry('s-t1'));
    mountComposer(session, 'c1');

    const result = insertToSessionAgent(session, 'review this diff');

    expect(result).toEqual({
      ok: true,
      landedTabTitle: 'chat-c1',
      isFallback: true, // 前台是 t1，落在 c1
    });
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('composer 未挂载（tab 存在于 store 但无接收端）→ 降级 Agent CLI 终端', () => {
    setTabs(
      session.key,
      [chatTab('c1', 0, session), tab('t-agent', 1, 'terminal', session, 'claude')],
      'c1',
    );
    terminalCache.set(terminalAddress(session, 't-agent'), makeEntry('s-cli'));

    const result = insertToSessionAgent(session, 'hi');

    expect(result.ok).toBe(true);
    // 「落在哪一类」不给字段（零生产消费者，R4）—— 落点标题 + 是否 emit 已足以区分两类目标。
    expect(result.landedTabTitle).toBe('terminal-t-agent');
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  /**
   * 两个 composer 并存、**只有第二个挂载** —— 编排必须沿序继续试而不是
   * 「取首个就定死」。这一步取的是 registry 的返回值作为「有没有人在」的答案，
   * 不探测「已挂载集合」（那会是第二份真相）。
   */
  it('首个 composer 未挂载 → 沿 order 升序试到第二个', () => {
    setTabs(session.key, [chatTab('c1', 0, session), chatTab('c2', 1, session)], 'c1');
    mountComposer(session, 'c2');

    const result = insertToSessionAgent(session, 'x');

    expect(result.ok).toBe(true);
    expect(result.landedTabTitle).toBe('chat-c2');
    expect(mockEmit).not.toHaveBeenCalled(); // 落在 composer，不碰 PTY
  });

  /** 接收端自行拒收（handler 返回 false）也必须继续降级，不谎报成功。 */
  it('composer 拒收 → 降级到 Agent CLI', () => {
    setTabs(
      session.key,
      [chatTab('c1', 0, session), tab('t-agent', 1, 'terminal', session, 'claude')],
      'c1',
    );
    terminalCache.set(terminalAddress(session, 't-agent'), makeEntry('s-cli'));
    mountComposer(session, 'c1', false); // 已挂载，但本次不接

    const result = insertToSessionAgent(session, 'x');

    expect(result.ok).toBe(true);
    expect(result.landedTabTitle).toBe('terminal-t-agent');
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  /** 本 defect 的正面反证：两边都没 → **显式 false**（调用方的 clipboard 兜底重新可达）。 */
  it('无 composer 且无 Agent CLI → 显式 false 且不 emit', () => {
    setTabs(session.key, [tab('t-plain', 0, 'terminal', session)], 't-plain');
    terminalCache.set(terminalAddress(session, 't-plain'), makeEntry('s-plain'));

    expect(insertToSessionAgent(session, 'x')).toEqual({ ok: false });
    // 普通终端（agentId === null）不是 agent 目标 —— 不能静默写进去。
    expect(mockEmit).not.toHaveBeenCalled();
  });

  /** 跨 session 不串：另一个 workspace 的 composer 不得接住本次投递。 */
  it('worktree 与主仓并存 → 只命中目标 session', () => {
    const wt = WorkspaceSession.of('proj1', '/wt/a');
    setTabs(session.key, [chatTab('c-main', 0, session)], 'c-main');
    setTabs(wt.key, [chatTab('c-wt', 0, wt)], 'c-wt');
    const seen: string[] = [];
    mounted.push([wt, 'c-wt']);
    registerAgentInput(wt, 'c-wt', (text) => {
      seen.push(text);
      return true;
    });
    mountComposer(session, 'c-main');

    expect(insertToSessionAgent(session, 'to-main').ok).toBe(true);
    expect(seen).toEqual([]);
  });

  /** Agent CLI 在但 PTY 未就绪 → 不谎报成功。 */
  it('降级目标 PTY 未就绪 → false', () => {
    setTabs(session.key, [tab('t-agent', 0, 'terminal', session, 'claude')], 't-agent');
    terminalCache.set(terminalAddress(session, 't-agent'), makeEntry(null));

    expect(insertToSessionAgent(session, 'x')).toEqual({ ok: false });
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('insertAgentInput 就是路由用的同一个 registry（接线未断）', () => {
    mountComposer(session, 'c1');
    expect(insertAgentInput(session, 'c1', 'x')).toBe(true);
  });
});
