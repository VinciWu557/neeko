/**
 * `ChatLaunch` 的传输识别与进程内桩判据（前端镜像）。
 *
 * 这两条规则必须与后端逐字对齐：
 * - `transportOf` ↔ `ChatLaunch::transport()`
 * - `isInprocessChat` ↔ `AgentConfig::is_inprocess_chat()`
 *
 * 对齐本身由 `features/agent/components/__tests__/chatLaunch.test.ts` 的
 * 跨栈护栏核对（它直接读 Rust 源码）。这里只锁前端的独立行为。
 */
import { describe, expect, it } from 'vitest';

import type { ChatLaunch } from '../agent';
import { isInprocessChat, transportOf } from '../agent';

describe('transportOf', () => {
  it('should default to acp when no token matches', () => {
    expect(transportOf({})).toBe('acp');
    expect(transportOf({ program: 'gemini' })).toBe('acp');
  });

  it('should recognise each documented launch shape', () => {
    const cases: [ChatLaunch, string][] = [
      [{ program: 'opencode', args: ['acp'] }, 'acp'],
      [{ program: 'opencode', args: ['serve'] }, 'serve'],
      [{ args: ['--jsonl'] }, 'jsonl'],
      [{ args: ['--mode', 'rpc'] }, 'pi-rpc'],
    ];
    for (const [launch, expected] of cases) {
      expect(transportOf(launch)).toBe(expected);
    }
  });

  it('should return null when there is no chat capability', () => {
    expect(transportOf(null)).toBeNull();
    expect(transportOf(undefined)).toBeNull();
  });

  it('should treat a blank program as absent', () => {
    expect(transportOf({ program: '   ', args: ['serve'] })).toBe('serve');
  });
});

describe('isInprocessChat', () => {
  it('should read the explicit inprocess declaration', () => {
    // mockAgent 的形状：有 chat、显式声明 inprocess。
    expect(isInprocessChat({ chat: { inprocess: true } })).toBe(true);
  });

  it('should be false without a chat capability', () => {
    expect(isInprocessChat({ chat: null })).toBe(false);
    expect(isInprocessChat({})).toBe(false);
  });

  /**
   * **空命令行不等于进程内实现**：用户清空 command 却保留 chat 声明时，
   * 不能静默路由到 mock adapter（那会得到「能连上但永远不回话」的会话）。
   *
   * 变异验证：改回「command 为空 + 无 program 即 inprocess」→ 本用例红。
   */
  it('should not infer inprocess from a blank command', () => {
    expect(isInprocessChat({ chat: {} })).toBe(false);
    expect(isInprocessChat({ chat: { args: ['acp'] } })).toBe(false);
  });
});
