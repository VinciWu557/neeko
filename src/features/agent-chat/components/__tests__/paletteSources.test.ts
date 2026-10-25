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
  groupOfSource,
  groupPaletteItems,
  PALETTE_ITEM_LIMIT,
  searchPaletteItems,
} from '../paletteSources';
import type { PaletteItem } from '../paletteSources';

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
    // description 缺失时不编造说明（来源已有独立的分组标题与图标，不再重复塞进 sublabel）
    expect(items[1].sublabel).toBeUndefined();
    // source 随 item 透传 —— chip 的类型化配色（R1）依赖它。
    expect(items[0].source).toBe('prompt');
    expect(items[2].source).toBe('skill');
    // 分组由 source 归一而来：prompt → command，skill → skill，extension → extension
    expect(items.map((i) => i.group)).toEqual(['command', 'extension', 'skill']);
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

  /**
   * **文件源没有 onPick 副作用**（B 方案）：文件的唯一表示是编辑器里的 file chip，
   * 请求的 `files` 由文档投影产出。曾经这里回调 `addAttachment` 写第二份状态 ——
   * 那份状态与文档不同步，退格删掉 chip 后文件仍会被发送。
   */
  it('should not own a side effect for picked files', () => {
    const source = createMentionSource(TREE);
    expect(source.onPick).toBeUndefined();
    expect(source.getItems('App').map((i) => i.value)).toEqual(['src/App.tsx']);
    expect(source.getItems('App')[0].group).toBe('file');
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

/**
 * 搜索增强：多词输入按 token 逐个匹配（直接子串匹配对多词是全灭的），
 * 且命令的 description 也参与匹配（用户常记得语义而非命令名）。
 */
describe('searchPaletteItems', () => {
  const items: PaletteItem[] = [
    {
      value: 'trellis-continue',
      label: 'trellis-continue',
      sublabel: 'Resume work',
      group: 'command',
    },
    {
      value: 'skill:code-walkthrough',
      label: 'code-walkthrough',
      sublabel: 'Read Neeko code',
      group: 'skill',
      keywords: ['与用户共同阅读'],
    },
    {
      value: 'src/features/x/components/ChatComposer.tsx',
      label: 'ChatComposer.tsx',
      sublabel: 'src/features/x/components/ChatComposer.tsx',
      group: 'file',
      keywords: ['src/features/x/components/'],
    },
  ];

  it('should require every whitespace-separated token to match (not the whole string)', () => {
    // 整串子串匹配对 `trellis cont` 是全灭的；按 token 匹配才命中
    expect(searchPaletteItems(items, 'trellis cont', 10).map((i) => i.value)).toEqual([
      'trellis-continue',
    ]);
    expect(searchPaletteItems(items, 'chat composer', 10).map((i) => i.value)).toEqual([
      'src/features/x/components/ChatComposer.tsx',
    ]);
  });

  it('should match against the description and extra keywords', () => {
    expect(searchPaletteItems(items, 'walkthrough', 10).map((i) => i.value)).toEqual([
      'skill:code-walkthrough',
    ]);
    // 中文说明也参与匹配（subagent/skill 的 description 常是中文）
    expect(searchPaletteItems(items, '阅读', 10).map((i) => i.value)).toEqual([
      'skill:code-walkthrough',
    ]);
  });

  /** 前缀命中的排前 —— 用户打的通常是想找的那个的开头。 */
  it('should rank label-prefix matches first', () => {
    const value = searchPaletteItems(
      [
        { value: 'x-continue', label: 'x-continue', group: 'command' },
        { value: 'continue', label: 'continue', group: 'command' },
      ],
      'continue',
      10,
    ).map((i) => i.value);
    expect(value[0]).toBe('continue');
  });

  it('should return a bounded list for an empty query', () => {
    expect(searchPaletteItems(items, '   ', 2)).toHaveLength(2);
  });
});

describe('groupPaletteItems', () => {
  it('should bucket items into stable-ordered sections and drop empty groups', () => {
    const sections = groupPaletteItems([
      { value: 'a.ts', label: 'a.ts', group: 'file' },
      { value: 'cmd', label: 'cmd', group: 'command' },
      { value: 'sk', label: 'sk', group: 'skill' },
    ]);
    expect(sections.map((s) => s.group)).toEqual(['skill', 'command', 'file']);
    expect(sections.map((s) => s.label)).toEqual(['Skills', 'Commands', 'Files']);
  });

  it('should keep same-group items in their original order', () => {
    const sections = groupPaletteItems([
      { value: 'b', label: 'b', group: 'skill' },
      { value: 'a', label: 'a', group: 'skill' },
    ]);
    expect(sections[0].items.map((i) => i.value)).toEqual(['b', 'a']);
  });
});

describe('groupOfSource', () => {
  it('should map known sources and fall back to other for unknown ones', () => {
    expect(groupOfSource('prompt')).toBe('command');
    expect(groupOfSource('skill')).toBe('skill');
    expect(groupOfSource('extension')).toBe('extension');
    expect(groupOfSource(null)).toBe('other');
    expect(groupOfSource('brand-new-source')).toBe('other');
  });
});
