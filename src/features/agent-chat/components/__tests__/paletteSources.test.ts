/**
 * paletteSources 数据源工厂的直测 + **AC2 静态护栏**。
 *
 * # AC2：命令列表不得硬编码在前端
 *
 * `AGENT_MODES` / `THINKING_LEVELS` 的硬编码缺陷同源（10-21-pi-rpc-adapter）：
 * 界面正常但后端没变，且不同 agent 的命令集完全不同 —— 硬编码一份等于只支持
 * pi。阶段 3 的 MOCK_COMMANDS 已随真实数据源删除；本护栏防止它以任何形式回来。
 */
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AgentCommandEntry } from '@/shared/types/agentChat';
import type { FileNode } from '@/shared/types/file';

import {
  createCommandSource,
  createMentionSource,
  flattenFiles,
  PALETTE_ITEM_LIMIT,
} from '../paletteSources';

const COMMANDS: AgentCommandEntry[] = [
  { name: 'trellis-continue', description: 'Continue Current Task', source: 'prompt' },
  { name: 'vision-handoff', description: null, source: 'extension' },
  { name: 'skill:code-walkthrough', description: 'walk through code', source: 'skill' },
];

const TREE: FileNode[] = [
  {
    name: 'src',
    path: 'src',
    is_dir: true,
    children: [
      { name: 'App.tsx', path: 'src/App.tsx', is_dir: false, children: [] },
      {
        name: 'agent-chat',
        path: 'src/agent-chat',
        is_dir: true,
        children: [
          {
            name: 'ChatComposer.tsx',
            path: 'src/agent-chat/ChatComposer.tsx',
            is_dir: false,
            children: [],
          },
        ],
      },
    ],
  },
  { name: 'README.md', path: 'README.md', is_dir: false, children: [] },
];

describe('createCommandSource', () => {
  it('should map command entries into palette items', () => {
    const source = createCommandSource(COMMANDS);
    expect(source.kind).toBe('slash');
    const items = source.getItems('');
    expect(items.map((i) => i.value)).toEqual([
      'trellis-continue',
      'vision-handoff',
      'skill:code-walkthrough',
    ]);
    expect(items[0].sublabel).toBe('Continue Current Task');
    // description 缺失时回落来源标记，而不是 undefined 渲染成空。
    expect(items[1].sublabel).toBe('extension');
  });

  it('should filter by substring, case-insensitively', () => {
    const items = createCommandSource(COMMANDS).getItems('WALK');
    expect(items.map((i) => i.value)).toEqual(['skill:code-walkthrough']);
  });

  it('should distinguish "no commands" from "no match" (R2)', () => {
    // 支持但为空 → 明确的空态文案，不是装作没有该功能。
    expect(createCommandSource([]).emptyText).not.toBe(createCommandSource(COMMANDS).emptyText);
    expect(createCommandSource(COMMANDS).getItems('zzz-no-hit')).toEqual([]);
  });

  it('should bound the list even with an empty query', () => {
    const many: AgentCommandEntry[] = Array.from({ length: PALETTE_ITEM_LIMIT + 10 }, (_, i) => ({
      name: `cmd-${i}`,
    }));
    expect(createCommandSource(many).getItems('')).toHaveLength(PALETTE_ITEM_LIMIT);
  });
});

describe('createMentionSource', () => {
  const onPick = vi.fn();

  it('should flatten the tree into leaf files and filter by path', () => {
    const source = createMentionSource(TREE, onPick);
    expect(source.kind).toBe('mention');
    const items = source.getItems('');
    // 目录不参与选择，只出叶子文件。
    expect(items.map((i) => i.value)).toEqual([
      'src/App.tsx',
      'src/agent-chat/ChatComposer.tsx',
      'README.md',
    ]);
    expect(items[1].label).toBe('ChatComposer.tsx');
    expect(items[1].sublabel).toBe('src/agent-chat/ChatComposer.tsx');

    expect(source.getItems('agent-chat').map((i) => i.value)).toEqual([
      'src/agent-chat/ChatComposer.tsx',
    ]);
  });

  it('should report files not loaded yet while the tree is empty', () => {
    const source = createMentionSource([], onPick);
    expect(source.emptyText).toContain('loaded');
    expect(source.getItems('')).toEqual([]);
  });

  it('should delegate the pick to the attachment path with (path, name)', () => {
    const source = createMentionSource(TREE, onPick);
    source.onPick?.({ value: 'src/App.tsx', label: 'App.tsx' });
    expect(onPick).toHaveBeenCalledWith('src/App.tsx', 'App.tsx');
  });
});

describe('flattenFiles (shared with AttachFilePicker)', () => {
  it('should recurse into nested dirs and drop directories', () => {
    const leaves = flattenFiles(TREE);
    expect(leaves.every((n) => !n.is_dir)).toBe(true);
    expect(leaves).toHaveLength(3);
  });
});

/**
 * **AC2 静态护栏**：本文件不得再出现硬编码命令清单。
 *
 * 变异验证：往 paletteSources.ts 加回 `const MOCK_COMMANDS: PaletteItem[] = [...]`
 * 之类的字面量数组 → 本用例红。
 */
describe('AC2 static guard: no hardcoded command list in the frontend', () => {
  it('paletteSources.ts must build items from real data only', () => {
    const src = readFileSync(resolve(__dirname, '../paletteSources.ts'), 'utf8');
    // 先剥块注释再剥行注释 —— 文档里提到具体命令名是合法的教训引用。
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/:\s*PaletteItem\[\]\s*=\s*\[/);
    expect(code).not.toContain('MOCK_COMMANDS');
    // 具体命令名（阶段 3 假数据的遗迹）不得重新出现在代码里。
    expect(code).not.toContain('trellis-continue');
    expect(code).not.toContain('skill:code-walkthrough');
  });
});
