import {
  nextBlockId,
  nextMsgId,
  type ChatMessage,
  type ContentBlock,
} from '../components/messageModel';
import type { FileStat, ToolCard } from '../types';
import { formatChatTime } from '../utils/chatFormat';
import { diffStats } from '../utils/diffHighlight';
import { withParagraphBreak } from '../utils/messageContent';

/**
 * 将 file_diff 聚合进最后一条 assistant 消息的 diff block（按 path 去重）。
 * 若消息末尾已是 diff block 则合并，否则新建 diff block。
 */
export function attachFileDiff(prev: ChatMessage[], path: string, diff: string): ChatMessage[] {
  const stats = diffStats(diff);
  const file: FileStat = { path, add: stats.add, del: stats.del };
  const last = prev[prev.length - 1];

  if (last && last.role === 'assistant') {
    const lastBlock = last.blocks[last.blocks.length - 1];
    // 末尾已是 diff block → 合并（同 path 更新，异 path 追加）
    if (lastBlock && lastBlock.kind === 'diff') {
      const current = lastBlock.diff;
      const exists = current.files.some((f) => f.path === path);
      const files = exists
        ? current.files.map((f) => (f.path === path ? file : f))
        : [...current.files, file];
      const diffs = exists
        ? current.diffs.map((d) => (d.path === path ? { path, diff } : d))
        : [...current.diffs, { path, diff }];
      return prev.map((m, i) =>
        i === prev.length - 1
          ? {
              ...m,
              blocks: m.blocks.map((b, j) =>
                j === m.blocks.length - 1 ? { ...b, diff: { files, diffs } } : b,
              ),
            }
          : m,
      );
    }
    // 末尾不是 diff block → 新建 diff block
    return appendBlock(prev, {
      kind: 'diff',
      id: nextBlockId(),
      diff: { files: [file], diffs: [{ path, diff }] },
    });
  }
  // 无 assistant 消息 → 新建消息 + diff block
  return [
    ...prev,
    {
      id: nextMsgId(),
      role: 'assistant',
      blocks: [
        { kind: 'diff', id: nextBlockId(), diff: { files: [file], diffs: [{ path, diff }] } },
      ],
      ts: formatChatTime(new Date()),
    },
  ];
}

/**
 * 在消息列表中查找 tool block（跨所有消息），用于 tool_output / tool_end 更新。
 * 返回 { msgIndex, blockIndex } 或 null。
 */
export function findToolBlock(
  msgs: ChatMessage[],
  callId: string,
): { msgIndex: number; blockIndex: number } | null {
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    for (let j = 0; j < msg.blocks.length; j++) {
      const b = msg.blocks[j];
      if (b.kind === 'tool' && b.tool.callId === callId) {
        return { msgIndex: i, blockIndex: j };
      }
    }
  }
  return null;
}

/**
 * 按时序追加内容块：末尾消息是 assistant 则追加到其 blocks，否则新建 assistant 消息。
 * 流式事件（tool_start / todos / worked / diff）共用的块追加语义。
 */
export function appendBlock(prev: ChatMessage[], block: ContentBlock): ChatMessage[] {
  const last = prev[prev.length - 1];
  if (last && last.role === 'assistant') {
    return prev.map((m, i) => (i === prev.length - 1 ? { ...m, blocks: [...m.blocks, block] } : m));
  }
  return [
    ...prev,
    {
      id: nextMsgId(),
      role: 'assistant',
      blocks: [block],
      ts: formatChatTime(new Date()),
    },
  ];
}

/**
 * 命令块追加：若末尾 assistant 消息的最后一个 block 是文本，先补段落分隔
 * （避免文本与命令糅合），再追加 command block。
 */
export function appendCommandBlock(prev: ChatMessage[], block: ContentBlock): ChatMessage[] {
  const last = prev[prev.length - 1];
  if (last && last.role === 'assistant') {
    // 若末尾是 text block，追加段落分隔（避免文本与命令糅合）
    const lastBlock = last.blocks[last.blocks.length - 1];
    if (lastBlock && lastBlock.kind === 'text') {
      return prev.map((m, i) =>
        i === prev.length - 1
          ? {
              ...m,
              blocks: [
                ...m.blocks.slice(0, -1),
                { ...lastBlock, text: withParagraphBreak(lastBlock.text) },
                block,
              ],
            }
          : m,
      );
    }
    return prev.map((m, i) => (i === prev.length - 1 ? { ...m, blocks: [...m.blocks, block] } : m));
  }
  return [
    ...prev,
    {
      id: nextMsgId(),
      role: 'assistant',
      blocks: [block],
      ts: formatChatTime(new Date()),
    },
  ];
}

/**
 * 话轮结束时把所有 `running` 的工具块标记为 `done`.
 *
 * # 为什么需要
 *
 * 工具块的 `done` 通常由 `tool_end` 事件给出。但 agent 崩溃、被取消、或
 * 直接 `turn_end` 而不发 `tool_end` 时（实测 opencode serve 的取消路径），
 * 卡片会一直转圈。
 *
 * 这是纯 reducer（输入输出都是数组），所以能被密集单测 —— 变异验证：
 * 删掉 `status === 'running'` 判据会把**已完成**的块也改写（丢掉 `failed`）。
 */
export function closeRunningTools(prev: ChatMessage[]): ChatMessage[] {
  return prev.map((m) => ({
    ...m,
    blocks: m.blocks.map((b) =>
      b.kind === 'tool' && b.tool.status === 'running'
        ? { ...b, tool: { ...b.tool, status: 'done' } }
        : b,
    ),
  }));
}

/**
 * 就地改写某条 `callId` 的 tool block（**跨消息**定位）。
 *
 * # 为什么需要
 *
 * `tool_output`（累积输出）与 `tool_end`（更新状态）用的是同一套 26 行结构：
 * 查找 → 逐层 map → 只改命中那一块。两处复制会漂移 —— 比如一处加上「找不到
 * 就新建」，另一处没加，行为就不一致了。
 *
 * 收成一个「取旧 tool、返回新 tool」的入口后：
 * - 定位逻辑只有一份（`findToolBlock` 已抽，这里再加一层不可变更新）；
 * - 两个消费点只表达**差异**（改 output vs 改 status）；
 * - 找不到时原样返回，不会凭空造块。
 *
 * @param update 把旧 `tool` 映射成新 `tool`（纯函数，不得原地改）。
 */
export function updateToolBlock(
  prev: ChatMessage[],
  callId: string,
  update: (tool: ToolCard) => ToolCard,
): ChatMessage[] {
  const found = findToolBlock(prev, callId);
  if (!found) return prev;
  const { msgIndex, blockIndex } = found;
  return prev.map((m, i) =>
    i === msgIndex
      ? {
          ...m,
          blocks: m.blocks.map((b, j) =>
            j === blockIndex && b.kind === 'tool' ? { ...b, tool: update(b.tool) } : b,
          ),
        }
      : m,
  );
}
