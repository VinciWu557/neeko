import type { AgentCommandEntry } from '@/shared/types/agentChat';
import type { FileNode } from '@/shared/types/file';

import type { ChipKind } from './composer/chipSpec';

/**
 * 弹层/数据源侧的种类键 —— **就是** `ChipKind`（同一条轴，不另立概念）。
 * 曾有两份同形类型（`PaletteKind` 与 `ChipKind`），任一侧加种类另一侧不会报错。
 */
export type PaletteKind = ChipKind;

/**
 * 候选的分组标签（决定弹层里的分组标题与配色/图标）。
 *
 * 它是**展示维度**，不是数据来源：命令按 agent 给的 `source` 归一到这里
 * （pi 的 `prompt` / `skill` / `extension`），文件归 `file`。未知来源一律落
 * `other`，而不是白屏或假装它是命令。
 */
export type PaletteGroup = 'skill' | 'command' | 'extension' | 'file' | 'other';

/** 补全候选的统一形状：`/` 与 `@` 的差异只剩「数据从哪来」与「选中后做什么」。 */
export interface PaletteItem {
  /** 选中后插入的文本（不含触发符与尾随空格，如 `trellis-continue` 或 `src/foo.ts`）。 */
  value: string;
  /** 主显示文本（命令名 / 文件名）。 */
  label: string;
  /** 次要说明（命令 description / 完整路径）。 */
  sublabel?: string;
  /** 命令来源标记（prompt / skill / extension），供 chip 类型化配色（R1）。 */
  source?: string | null;
  /** 弹层分组（带标题 + 图标 + 配色）。 */
  group: PaletteGroup;
  /** 搜索用的额外关键词（路径片段等）；`value`/`label`/`sublabel` 已参与匹配。 */
  keywords?: string[];
}

/** 弹层的数据源适配（design「骨架 + 数据源」两件套中的后者）。 */
export interface ComposerPaletteSource {
  kind: PaletteKind;
  /** 无匹配时的空态文案（R2：支持但为空要显示「无」，不是装作没有该功能）。 */
  emptyText: string;
  getItems: (query: string) => PaletteItem[];
  /** 选中候选后的额外副作用（如 @ 文件 → addAttachment）。 */
  onPick?: (item: PaletteItem) => void;
}

/** 单次弹出的候选上限：空 query 也只展示前 N 条，不倾倒全量列表。 */
export const PALETTE_ITEM_LIMIT = 50;

/**
 * 分组的展示顺序与标题。
 *
 * 顺序即优先级：技能与命令是用户最常按 `/` 找的东西，`other` 垫底。
 * `command` 排在 `skill` 之后是因为 pi 的 `source: prompt` 常是项目自定义流程，
 * 而 skill 集合更长、更需要先看到。
 */
export const PALETTE_GROUP_ORDER: readonly PaletteGroup[] = [
  'skill',
  'command',
  'extension',
  'other',
  'file',
];

export const PALETTE_GROUP_LABELS: Record<PaletteGroup, string> = {
  skill: 'Skills',
  command: 'Commands',
  extension: 'Extensions',
  other: 'Other',
  file: 'Files',
};

/**
 * 把 agent 给的原始 `source` 归一到展示分组。
 *
 * 只做**映射**，不做猜测：未知来源归 `other`（以前端硬编码的方式「认领」未知
 * 来源会让新 agent 的来源凭空消失或误标成命令）。
 */
export function groupOfSource(source: string | null | undefined): PaletteGroup {
  switch (source) {
    case 'skill':
      return 'skill';
    case 'prompt':
      return 'command';
    case 'extension':
      return 'extension';
    default:
      return 'other';
  }
}

/** 一个分组里的候选（弹层按它渲染分组标题）。 */
export interface PaletteGroupSection {
  group: PaletteGroup;
  label: string;
  items: PaletteItem[];
}

/**
 * 把文件树摊平成叶子文件（目录不参与选择）。
 *
 * 返回值是 `FileNode[]` 而非新类型：`is_dir` 已在构造时被滤成 `false`，调用方
 * 不需要再判。`AttachFilePicker` 与 `@` 提及共用这一份 —— 摊平规则若有修正
 * （比如跳过 node_modules），两处必须同时生效。
 */
export function flattenFiles(nodes: FileNode[], out: FileNode[] = []): FileNode[] {
  for (const node of nodes) {
    if (node.is_dir) {
      flattenFiles(node.children ?? [], out);
    } else {
      out.push(node);
    }
  }
  return out;
}

/**
 * slash 数据源：agent 的命令列表（`list_agent_commands`，来自 pi 的
 * `get_commands` —— spec `agent-chat-transports.md` §9.4）。
 *
 * 列表为空与「过滤无命中」是两种处境（R2）：前者说明 agent 没有暴露任何
 * 命令，文案用 "No commands available"；后者才说 "No matching commands"。
 */
export function createCommandSource(commands: readonly AgentCommandEntry[]): ComposerPaletteSource {
  const items: PaletteItem[] = commands.map((c) => ({
    value: c.name,
    label: c.name,
    sublabel: c.description ?? undefined,
    source: c.source ?? null,
    group: groupOfSource(c.source),
    // 命令的说明文本也参与搜索：用户常记得「那个做 walkthrough 的」而记不住名字
    keywords: c.description ? [c.description] : undefined,
  }));
  return {
    kind: 'slash',
    emptyText: commands.length === 0 ? 'No commands available' : 'No matching commands',
    getItems: (query) => searchPaletteItems(items, query, PALETTE_ITEM_LIMIT),
  };
}

/**
 * mention 数据源：项目文件树（`readDirTree` + 摊平，与 AttachFilePicker 同源）。
 *
 * 树尚未加载时（首次进入 tab 的在途窗口）显示 "No files loaded yet" —— 加载
 * 完成后父级重建 sources，弹层自然补上列表。
 *
 * **没有 onPick 副作用**：文件的唯一表示是编辑器文档（插入 file chip），请求的
 * `files` 由文档投影产出（`docToRequestFiles`）。这里不再写第二份附件状态 ——
 * 那曾导致「退格删掉 chip 后文件仍会被发送」。
 */
export function createMentionSource(files: readonly FileNode[]): ComposerPaletteSource {
  // 摊平一次（sources 只在文件树变化时重建），getItems 在每次按键时都会被调。
  const items: PaletteItem[] = flattenFiles([...files]).map((f) => ({
    value: f.path,
    label: f.name,
    sublabel: f.path,
    group: 'file' as const,
    // 目录片段单独入关键词：`components` 能命中 `src/features/x/components/Y.tsx`
    keywords: [f.path.slice(0, Math.max(0, f.path.length - f.name.length))],
  }));
  return {
    kind: 'mention',
    emptyText: files.length === 0 ? 'No files loaded yet' : 'No matching files',
    getItems: (query) => searchPaletteItems(items, query, PALETTE_ITEM_LIMIT),
  };
}

/**
 * 候选搜索：**按 token 逐个匹配**（空格分隔的每一段都必须命中某个字段），
 * 而不是把整串当子串。
 *
 * 这让 `trellis cont` 能命中 `trellis-continue`，`chat composer` 能命中
 * `components/ChatComposer.tsx` —— 直接子串匹配对多词输入是全灭的，而用户
 * 搜索时几乎总是打关键词而非完整标识符。
 *
 * 排序：命中 `label` 前缀的排前（更像用户想找的那个），其余保持数据源原序
 * （命令按 agent 给的顺序、文件按树序）—— 不做模糊打分，避免结果顺序难解释。
 */
export function searchPaletteItems(
  items: readonly PaletteItem[],
  query: string,
  limit: number,
): PaletteItem[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return items.slice(0, limit);
  const haystack = (item: PaletteItem): string =>
    [item.value, item.label, item.sublabel ?? '', ...(item.keywords ?? [])]
      .join('\n')
      .toLowerCase();
  const matched = items.filter((item) => {
    const hay = haystack(item);
    return tokens.every((t) => hay.includes(t));
  });
  // 稳定排序：前缀命中优先，其余保持原序（Array.sort 在 ES2019+ 是稳定的）
  return [...matched]
    .sort((a, b) => {
      const ap = a.label.toLowerCase().startsWith(tokens[0]) ? 0 : 1;
      const bp = b.label.toLowerCase().startsWith(tokens[0]) ? 0 : 1;
      return ap - bp;
    })
    .slice(0, limit);
}

/**
 * 把候选按分组切开（弹层据此渲染分组标题）。空组不返回，组顺序按
 * `PALETTE_GROUP_ORDER`（不依赖数据到达顺序）。
 */
export function groupPaletteItems(items: readonly PaletteItem[]): PaletteGroupSection[] {
  const buckets = new Map<PaletteGroup, PaletteItem[]>();
  for (const item of items) {
    const bucket = buckets.get(item.group);
    if (bucket) bucket.push(item);
    else buckets.set(item.group, [item]);
  }
  return PALETTE_GROUP_ORDER.filter((g) => buckets.has(g)).map((group) => ({
    group,
    label: PALETTE_GROUP_LABELS[group],
    items: buckets.get(group) ?? [],
  }));
}
