import type { AgentCommandEntry } from '@/shared/types/agentChat';
import type { FileNode } from '@/shared/types/file';

import { filterBySubstring } from './paletteTrigger';
import type { PaletteKind } from './paletteTrigger';

/** 补全候选的统一形状：`/` 与 `@` 的差异只剩「数据从哪来」与「选中后做什么」。 */
export interface PaletteItem {
  /** 选中后插入的文本（不含触发符与尾随空格，如 `trellis-continue` 或 `src/foo.ts`）。 */
  value: string;
  /** 主显示文本（命令名 / 文件名）。 */
  label: string;
  /** 次要说明（命令 description / 完整路径）。 */
  sublabel?: string;
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
    sublabel: c.description ?? c.source ?? undefined,
  }));
  return {
    kind: 'slash',
    emptyText: commands.length === 0 ? 'No commands available' : 'No matching commands',
    getItems: (query) => filterBySubstring(items, query, (c) => c.value, PALETTE_ITEM_LIMIT),
  };
}

/**
 * mention 数据源：项目文件树（`readDirTree` + 摊平，与 AttachFilePicker 同源）。
 *
 * 树尚未加载时（首次进入 tab 的在途窗口）显示 "No files loaded yet" —— 加载
 * 完成后父级重建 sources，弹层自然补上列表。选中回调交回附件链路
 * （`addAttachment(path, name)`，去重由 useChatAttachments 的唯一写路径承担）。
 */
export function createMentionSource(
  files: readonly FileNode[],
  onPickFile: (path: string, name: string) => void,
): ComposerPaletteSource {
  // 摊平一次（sources 只在文件树变化时重建），getItems 在每次按键时都会被调。
  const items: PaletteItem[] = flattenFiles([...files]).map((f) => ({
    value: f.path,
    label: f.name,
    sublabel: f.path,
  }));
  return {
    kind: 'mention',
    emptyText: files.length === 0 ? 'No files loaded yet' : 'No matching files',
    getItems: (query) => filterBySubstring(items, query, (f) => f.value, PALETTE_ITEM_LIMIT),
    onPick: (item) => onPickFile(item.value, item.label),
  };
}
