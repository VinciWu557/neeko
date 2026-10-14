import type { LucideIcon } from 'lucide-react';
import { createElement, type ReactNode } from 'react';

import { FilePlus, FileText, Pencil, Trash2 } from '@/shared/components/icons';
import { statusLetterToTextClass } from '@/shared/utils/gitFileDecoration';

/**
 * commit / stash 文件变更字母的统一「图标 + 名字色」来源。
 *
 * 域边界：commit / stash 的文件状态只有 M/A/D/R（后端 `CommitFileChange.status`），
 * 故图标表只覆盖这四者；其余字母（U/! 等仅工作树语义）回落 M 属**防御性兜底**。
 * CommitExpandPanel / CommitDetailPanel / StashPanel 三处消费共用，禁止各自私持字母对照表；
 * 颜色统一走 gitFileDecoration 的 `--git-status-*` 单一色板，与主题 UI accent 解耦。
 */
const ICON_BY_LETTER: Record<string, LucideIcon> = {
  M: Pencil,
  A: FilePlus,
  D: Trash2,
  R: FileText,
};

/** 字母 → `{ icon, color }`；未知字母回落到 M（modified）。 */
export function commitStatusIcon(
  letter: string | undefined,
  size: number,
): { icon: ReactNode; color: string } {
  const key = letter && ICON_BY_LETTER[letter] ? letter : 'M';
  return {
    icon: createElement(ICON_BY_LETTER[key], { size }),
    color: statusLetterToTextClass(key),
  };
}
