// @vitest-environment node
/**
 * agent 输入注册表（Q5=A：投递必须能回答「有人接住了吗」）。
 *
 * 形态照抄本仓两处同构先例（`editor/api/aiActionRegistry.ts`、`editor/api/editorViews.ts`）：
 * 身份键 + handler + 引用计数卸载 + 未命中返回 false。
 *
 * 本文件的**第一条用例就是当前 defect 的反证**：现状（DOM 广播 + 零监听者）永远给不出
 * 这个 false —— `dispatchEvent` 的返回值只表示「有无 preventDefault」。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { insertAgentInput, registerAgentInput, unregisterAgentInput } from '../agentInputRegistry';

const main = WorkspaceSession.of('proj-1', null);
const wt = WorkspaceSession.of('proj-1', '/wt/a');
const otherProject = WorkspaceSession.of('proj-2', null);

/** 记录收到的文本；返回 true 表示「已消费」。 */
function spy() {
  const seen: string[] = [];
  return {
    seen,
    handler: (text: string) => {
      seen.push(text);
      return true;
    },
  };
}

/**
 * 用例登记的身份逐条记账，afterEach 精确注销。
 * （不用「硬编码一串 tabId 轮流注销」——那会随用例增加静默漏清，
 *   而漏清恰好会让「未登记 → false」这条用例假绿。）
 */
const registered: Array<[WorkspaceSession, string]> = [];

function reg(session: WorkspaceSession, tabId: string, handler: (text: string) => boolean) {
  registered.push([session, tabId]);
  registerAgentInput(session, tabId, handler);
}

afterEach(() => {
  for (const [session, tabId] of registered.splice(0)) {
    // 计满两次时要减两次才归零：按已登记次数循环注销。
    unregisterAgentInput(session, tabId);
    unregisterAgentInput(session, tabId);
  }
});

describe('insertAgentInput · 显式失败（当前 defect 的反证）', () => {
  it('未登记任何 composer → false（现状是派发事件后静默丢弃，给不出这个 false）', () => {
    expect(insertAgentInput(main, 't1', 'hello')).toBe(false);
  });

  it('登记后投递成功，handler 收到原文', () => {
    const s = spy();
    reg(main, 't1', s.handler);
    expect(insertAgentInput(main, 't1', 'path/to/file ')).toBe(true);
    expect(s.seen).toEqual(['path/to/file ']);
  });

  it('handler 自行拒绝（返回 false）→ 投递判定 false，不谎报成功', () => {
    reg(main, 't1', () => false);
    expect(insertAgentInput(main, 't1', 'x')).toBe(false);
  });
});

describe('insertAgentInput · 身份精确性（红线 12）', () => {
  it('主仓与 worktree 并存：只命中目标 session', () => {
    const a = spy();
    const b = spy();
    reg(main, 't1', a.handler);
    reg(wt, 't1', b.handler);

    expect(insertAgentInput(main, 't1', 'to-main')).toBe(true);
    expect(a.seen).toEqual(['to-main']);
    expect(b.seen).toEqual([]);
  });

  it('同 session 内只命中目标 tabId', () => {
    const a = spy();
    const b = spy();
    reg(main, 't1', a.handler);
    reg(main, 't2', b.handler);

    expect(insertAgentInput(main, 't2', 'to-t2')).toBe(true);
    expect(b.seen).toEqual(['to-t2']);
    expect(a.seen).toEqual([]);
  });

  it('tabId 同名但 session 不同 → 不串（tabId 不是全局身份）', () => {
    const a = spy();
    const b = spy();
    reg(main, 't1', a.handler);
    reg(wt, 't1', b.handler);

    expect(insertAgentInput(wt, 't1', 'y')).toBe(true);
    expect(b.seen).toEqual(['y']);
    expect(a.seen).toEqual([]);
  });

  it('另一项目的同名 tab 不得命中', () => {
    const s = spy();
    reg(main, 't1', s.handler);
    expect(insertAgentInput(otherProject, 't1', 'nope')).toBe(false);
    expect(s.seen).toEqual([]);
  });
});

describe('unregister · 引用计数（design T2：StrictMode 双挂载）', () => {
  it('同身份 register×2 后 unregister×1 → 仍能投递（先卸载不得摘掉存活页）', () => {
    const s = spy();
    reg(main, 't1', s.handler);
    registerAgentInput(main, 't1', s.handler); // StrictMode 第二次挂载
    unregisterAgentInput(main, 't1'); // 第一次卸载

    expect(insertAgentInput(main, 't1', 'still-there')).toBe(true);
    expect(s.seen).toEqual(['still-there']);
  });

  it('计数归零后 → 显式 false', () => {
    const s = spy();
    reg(main, 't1', s.handler);
    unregisterAgentInput(main, 't1');
    expect(insertAgentInput(main, 't1', 'gone')).toBe(false);
  });

  it('多余的 unregister 不抛、不影响同 session 其他身份', () => {
    const s = spy();
    reg(main, 't1', s.handler);
    reg(main, 't2', s.handler);
    unregisterAgentInput(main, 't1');
    unregisterAgentInput(main, 't1'); // 已归零，再减必须是无操作
    expect(insertAgentInput(main, 't2', 'ok')).toBe(true);
  });

  it('同身份二次 register 覆盖 handler 且计数累加（与 aiActionRegistry 同构）', () => {
    const first = spy();
    const second = spy();
    reg(main, 't1', first.handler);
    registerAgentInput(main, 't1', second.handler);

    expect(insertAgentInput(main, 't1', 'x')).toBe(true);
    expect(first.seen).toEqual([]);
    expect(second.seen).toEqual(['x']);
  });
});
