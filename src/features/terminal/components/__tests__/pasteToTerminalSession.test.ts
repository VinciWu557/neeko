// @vitest-environment node
/**
 * bracketed-paste 写侧执行路径。
 *
 * 本文件前身是 `pasteToTerminal.test.ts`。`pasteToTerminal` 按决议 Q7 删除
 * （实测零生产消费者 —— 只有本文件与两个桶 re-export 供养它），其真实保护面
 * （bracketed 包裹、不补 `\r`、多行整段进缓冲）迁移到 `pasteToTerminalSession` +
 * `wrapBracketedPaste` 上，由 `terminalRouting.insertToSessionTerminal` 实际使用。
 *
 * **未迁移的一条**：旧用例「不传 tabId 时落到该 session 首个终端」—— 那正是本任务
 * 按 R1/R3 消灭的第二口径（Map 插入顺序首个），保留它等于给回潮留一张绿牌。
 * 「该落哪个 tab」的验收在 `terminalRouting.test.ts`。
 */
import { emit } from '@tauri-apps/api/event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { terminalInputEvent } from '@/shared/utils/terminalEvents';

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

import { pasteToTerminalSession, wrapBracketedPaste } from '../terminalCommands';

const mockEmit = vi.mocked(emit);

const START = '\x1b[200~';
const END = '\x1b[201~';

/** 把 emit 收到的字节还原成文本，便于断言「落到 PTY 的到底是什么」。 */
function emittedText(): string {
  const bytes = mockEmit.mock.calls[0][1] as number[];
  return new TextDecoder().decode(new Uint8Array(bytes));
}

beforeEach(() => {
  mockEmit.mockClear();
});

describe('wrapBracketedPaste', () => {
  it('首尾标记夹住原文', () => {
    expect(wrapBracketedPaste('hi')).toBe(`${START}hi${END}`);
  });
});

describe('pasteToTerminalSession', () => {
  it('整段 emit bracketed 字节到给定 sessionId 的事件通道', () => {
    pasteToTerminalSession('s1', 'echo hi');
    const expected = Array.from(new TextEncoder().encode(`${START}echo hi${END}`));
    expect(mockEmit).toHaveBeenCalledWith(terminalInputEvent('s1'), expected);
  });

  it('多行 content 整段进入缓冲：不补回车，零行被执行', () => {
    pasteToTerminalSession('s1', 'line1\nline2');
    expect(emittedText()).toBe(`${START}line1\nline2${END}`);
    expect(emittedText().endsWith('\r')).toBe(false);
  });

  /**
   * emit 失败：不抛（终端高频写入，尽力而为），但**必须留痕**。
   *
   * 可观察信号是 `log(...)`（`terminalCache` 的 log = console.debug）—— 不是「函数返回
   * undefined」，也不是「有没有 unhandled rejection」：后者在本 harness 下不构成信号
   * （实测删掉 `.catch` 四条用例照样全绿 = 假绿）。
   */
  it('emit 失败：吞掉异常但经 log 留痕', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      mockEmit.mockRejectedValueOnce(new Error('transport down'));
      pasteToTerminalSession('s1', 'x');
      // 排空微任务，让 .catch 有机会跑完。
      await Promise.resolve();
      await Promise.resolve();

      expect(mockEmit).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('pasteToTerminalSession error'));
    } finally {
      debug.mockRestore();
    }
  });
});
