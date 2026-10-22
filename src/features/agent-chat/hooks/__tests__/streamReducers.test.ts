// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../components/messageModel';
import {
  appendBlock,
  appendCommandBlock,
  attachFileDiff,
  closeRunningTools,
  findToolBlock,
  updateToolBlock,
} from '../streamReducers';

function assistantMsg(id: string, blocks: ChatMessage['blocks']): ChatMessage {
  return { id, role: 'assistant', blocks };
}

function textBlock(id: string, text: string): ChatMessage['blocks'][number] {
  return { kind: 'text', id, text };
}

function toolBlock(
  id: string,
  callId: string,
  status: 'running' | 'done' | 'failed' = 'running',
): ChatMessage['blocks'][number] {
  return { kind: 'tool', id, tool: { callId, name: 'edit_file', title: 'edit', status } };
}

describe('attachFileDiff', () => {
  it('新建消息 + diff block（无 assistant 消息时）', () => {
    const prev: ChatMessage[] = [];
    const next = attachFileDiff(prev, 'src/a.ts', '+1\n-1');
    expect(next).toHaveLength(1);
    expect(next[0].role).toBe('assistant');
    expect(next[0].blocks[0]).toMatchObject({
      kind: 'diff',
      diff: { files: [{ path: 'src/a.ts', add: 1, del: 1 }] },
    });
  });

  it('末尾 assistant 消息追加 diff block', () => {
    const prev = [assistantMsg('m1', [textBlock('b1', 'hello')])];
    const next = attachFileDiff(prev, 'src/a.ts', '+1');
    expect(next[0].blocks).toHaveLength(2);
    expect(next[0].blocks[1]).toMatchObject({
      kind: 'diff',
      diff: { files: [{ path: 'src/a.ts', add: 1, del: 0 }] },
    });
  });

  it('末尾已是 diff block 时合并（同 path 更新，异 path 追加）', () => {
    const prev = [
      assistantMsg('m1', [
        {
          kind: 'diff',
          id: 'b1',
          diff: {
            files: [{ path: 'src/a.ts', add: 1, del: 0 }],
            diffs: [{ path: 'src/a.ts', diff: '+1' }],
          },
        },
      ]),
    ];
    // 同 path → 更新（diffStats 按行计数：'+a\n+b' = 2 行新增）
    const merged = attachFileDiff(prev, 'src/a.ts', '+a\n+b');
    expect(merged[0].blocks[0]).toMatchObject({
      diff: {
        files: [{ path: 'src/a.ts', add: 2 }],
        diffs: [{ path: 'src/a.ts', diff: '+a\n+b' }],
      },
    });
    // 异 path → 追加
    const appended = attachFileDiff(prev, 'src/b.ts', '+c');
    const block = appended[0].blocks[0];
    expect(block.kind).toBe('diff');
    if (block.kind === 'diff') {
      expect(block.diff.files).toHaveLength(2);
      expect(block.diff.files[1]).toEqual({ path: 'src/b.ts', add: 1, del: 0 });
    }
  });

  it('最后一条不是 assistant 时新建消息', () => {
    const prev = [{ id: 'u1', role: 'user' as const, blocks: [textBlock('b1', 'q')] }];
    const next = attachFileDiff(prev, 'src/a.ts', '+1');
    expect(next).toHaveLength(2);
    expect(next[1].role).toBe('assistant');
  });
});

describe('findToolBlock', () => {
  it('跨消息找到匹配 callId 的 tool block', () => {
    const prev = [
      assistantMsg('m1', [toolBlock('b1', 'call_1')]),
      assistantMsg('m2', [toolBlock('b2', 'call_2')]),
    ];
    expect(findToolBlock(prev, 'call_2')).toEqual({ msgIndex: 1, blockIndex: 0 });
  });

  it('找不到时返回 null', () => {
    const prev = [assistantMsg('m1', [toolBlock('b1', 'call_1')])];
    expect(findToolBlock(prev, 'call_x')).toBeNull();
  });
});

describe('appendBlock', () => {
  it('末尾 assistant 消息时追加到其 blocks', () => {
    const prev = [assistantMsg('m1', [textBlock('b1', 'hello')])];
    const next = appendBlock(prev, toolBlock('b2', 'call_1'));
    expect(next[0].blocks).toHaveLength(2);
    expect(next[0].blocks[1]).toMatchObject({ kind: 'tool' });
  });

  it('末尾不是 assistant 时新建消息', () => {
    const prev = [{ id: 'u1', role: 'user' as const, blocks: [textBlock('b1', 'q')] }];
    const next = appendBlock(prev, toolBlock('b2', 'call_1'));
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ role: 'assistant', blocks: [{ kind: 'tool' }] });
  });
});

describe('appendCommandBlock', () => {
  it('末尾 text block 前补段落分隔', () => {
    const prev = [assistantMsg('m1', [textBlock('b1', 'run')])];
    const next = appendCommandBlock(prev, toolBlock('b2', 'call_1'));
    expect(next[0].blocks).toHaveLength(2);
    const first = next[0].blocks[0];
    expect(first.kind).toBe('text');
    if (first.kind === 'text') {
      expect(first.text).toContain('\n\n');
    }
    expect(next[0].blocks[1]).toMatchObject({ kind: 'tool' });
  });

  it('末尾不是 text block 时直接追加', () => {
    const prev = [assistantMsg('m1', [toolBlock('b1', 'call_0')])];
    const next = appendCommandBlock(prev, toolBlock('b2', 'call_1'));
    expect(next[0].blocks).toHaveLength(2);
    expect(next[0].blocks[1]).toMatchObject({ kind: 'tool' });
  });

  it('末尾不是 assistant 时新建消息', () => {
    const prev: ChatMessage[] = [];
    const next = appendCommandBlock(prev, toolBlock('b2', 'call_1'));
    expect(next).toHaveLength(1);
    expect(next[0].role).toBe('assistant');
  });
});

/**
 * `updateToolBlock` —— `tool_output` 与 `tool_end` 的共用入口。
 *
 * 两处曾是各 26 行的重复「查找 → 逐层 map → 改命中块」。抽成一个入口后
 * 两个消费点只表达差异（改 output vs 改 status）。
 */
describe('updateToolBlock', () => {
  function toolBlock(callId: string, status: 'running' | 'done' = 'running') {
    return {
      kind: 'tool' as const,
      id: `b-${callId}`,
      tool: { callId, name: 'bash', title: callId, status },
    };
  }

  const twoTools: ChatMessage[] = [
    {
      id: 'm1',
      role: 'assistant',
      blocks: [toolBlock('c1'), toolBlock('c2')],
    },
  ];

  /**
   * **只改命中的那一块**（同一消息里有两个 tool block）。
   *
   * 变异验证：去掉 `j === blockIndex` 判据 → 本用例变红（两块都被改）。
   */
  it('should update only the matching block when several live in one message', () => {
    const next = updateToolBlock(twoTools, 'c2', (t) => ({ ...t, status: 'done' }));
    const blocks = next[0].blocks;
    expect(blocks[0].kind === 'tool' && blocks[0].tool.status).toBe('running');
    expect(blocks[1].kind === 'tool' && blocks[1].tool.status).toBe('done');
  });

  /** 跨消息定位：命中项在第二条消息里也要改到。 */
  it('should locate the block across messages', () => {
    const msgs: ChatMessage[] = [
      { id: 'm1', role: 'user', blocks: [{ kind: 'text', id: 't1', text: 'hi' }] },
      { id: 'm2', role: 'assistant', blocks: [toolBlock('c9')] },
    ];
    const next = updateToolBlock(msgs, 'c9', (t) => ({ ...t, status: 'done' }));
    const b = next[1].blocks[0];
    expect(b.kind === 'tool' && b.tool.status).toBe('done');
    // 第一条消息原样返回（引用相等 = 没有无谓重建）
    expect(next[0]).toBe(msgs[0]);
  });

  /** 找不到时**原样返回**，不凭空造块（这是「输出丢了」类 bug 的防线）。 */
  it('should return the same array when the call id is unknown', () => {
    expect(updateToolBlock(twoTools, 'nope', (t) => ({ ...t, status: 'done' }))).toBe(twoTools);
  });

  /** 更新函数不得原地改旧对象（不可变更新）。 */
  it('should not mutate the previous tool object', () => {
    const before = twoTools[0].blocks[0];
    updateToolBlock(twoTools, 'c1', (t) => ({ ...t, status: 'done' }));
    expect(before.kind === 'tool' && before.tool.status).toBe('running');
  });
});

/**
 * `closeRunningTools` —— `turn_end` 时收尾仍然 `running` 的工具块。
 *
 * # 为什么必须直测
 *
 * 它是**纯 reducer**（输入输出都是数组），却只被 `useTurnStream` 间接使用。
 * `useTurnStream.test.ts` 里那条 `turn_end` 用例中的唯一工具就是 `running` 的，
 * 所以把 `status === 'running'` 判据删掉后**那条用例仍然绿** —— 变异测试抓不到。
 *
 * 缺这个判据的后果：`failed` 会被静默改写成 `done`，失败了却显示成功。
 */
describe('closeRunningTools', () => {
  const tool = (callId: string, status: 'running' | 'done' | 'failed') => ({
    kind: 'tool' as const,
    id: `b-${callId}`,
    tool: { callId, name: 'bash', title: callId, status },
  });

  it('should mark running tools as done', () => {
    const prev: ChatMessage[] = [{ id: 'm1', role: 'assistant', blocks: [tool('c1', 'running')] }];
    const b = closeRunningTools(prev)[0].blocks[0];
    expect(b.kind === 'tool' && b.tool.status).toBe('done');
  });

  /**
   * **已完成 / 已失败的工具不得被改写。**
   *
   * 变异验证：去掉 `b.tool.status === 'running'` 判据 → 本用例变红
   *（`failed` 变 `done`，用户看到失败的工具显示成功）。
   */
  it('should leave already-settled tools untouched', () => {
    const prev: ChatMessage[] = [
      { id: 'm1', role: 'assistant', blocks: [tool('a', 'done'), tool('b', 'failed')] },
    ];
    const blocks = closeRunningTools(prev)[0].blocks;
    expect(blocks[0].kind === 'tool' && blocks[0].tool.status).toBe('done');
    expect(blocks[1].kind === 'tool' && blocks[1].tool.status).toBe('failed');
  });

  /** 非 tool 块（文本 / todos / diff）原样保留。 */
  it('should keep non-tool blocks as they are', () => {
    const prev: ChatMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        blocks: [{ kind: 'text', id: 't1', text: 'hi' }, tool('c1', 'running')],
      },
    ];
    const blocks = closeRunningTools(prev)[0].blocks;
    expect(blocks[0]).toEqual({ kind: 'text', id: 't1', text: 'hi' });
    expect(blocks[1].kind === 'tool' && blocks[1].tool.status).toBe('done');
  });

  /** 跨消息：两条消息里的 running 工具都要收尾。 */
  it('should close running tools across messages', () => {
    const prev: ChatMessage[] = [
      { id: 'm1', role: 'assistant', blocks: [tool('c1', 'running')] },
      { id: 'm2', role: 'assistant', blocks: [tool('c2', 'running')] },
    ];
    const next = closeRunningTools(prev);
    expect(next[0].blocks[0].kind === 'tool' && next[0].blocks[0].tool.status).toBe('done');
    expect(next[1].blocks[0].kind === 'tool' && next[1].blocks[0].tool.status).toBe('done');
  });
});
