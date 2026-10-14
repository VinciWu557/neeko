import { MessageSquare } from 'lucide-react';

import { listPrompts } from '@/features/library/api/libraryApi';
import type { PromptResource } from '@/shared/types/library';

import type { ActionRegistryItem, ActionContext } from '../types/actionMenu';

/** Max number of recent resources shown in the dynamic palette section. */
const MAX_RECENT = 5;

interface RecentItem {
  id: string;
  name: string;
  lastUsedAt: number;
}

/**
 * Build dynamic Action Palette items for recently-used prompts.
 *
 * Reads prompts from the library API, sorts by `lastUsedAt`, and returns the
 * top `MAX_RECENT` as palette items that insert into the agent input.
 */
export async function getLibraryActionItems(ctx: ActionContext): Promise<ActionRegistryItem[]> {
  try {
    const prompts = await listPrompts();
    return buildRecentItems(prompts, ctx);
  } catch (e) {
    console.error('[libraryActionProvider] failed to load recent items:', e);
    return [];
  }
}

function buildRecentItems(prompts: PromptResource[], ctx: ActionContext): ActionRegistryItem[] {
  const items: RecentItem[] = prompts
    .filter((p) => p.lastUsedAt)
    .map((p) => ({
      id: `recent-prompt-${p.id}`,
      name: p.name,
      lastUsedAt: p.lastUsedAt ?? 0,
    }));

  items.sort((a, b) => b.lastUsedAt - a.lastUsedAt);

  return items.slice(0, MAX_RECENT).map((item) => {
    const prompt = prompts.find((p) => p.id === item.id.replace('recent-prompt-', ''));
    return {
      id: item.id,
      group: 'library' as const,
      label: `💬 ${item.name}`,
      description: 'Recently used prompt',
      icon: MessageSquare,
      keywords: ['prompt', 'recent', item.name],
      execute: () => {
        // 成败必须被处理：agent 目标一个都没有（既无 agent-chat composer 也无
        // Agent CLI tab）时给出可见反馈 —— 静默 no-op 是本次事故的原始症状
        // （决议 Q5=A 之后返回值才结构上可回答）。
        // 注意不写「prompt 已不可用」分支：recent 项由 prompts 自身派生，那个查找恒命中，
        // 那个分支不可达（本任务 TDD 的一条失败用例把它抓了出来）。
        if (prompt && !ctx.insertToAgentInput?.(prompt.content)) {
          ctx.showToast?.('无可用 agent 输入（agent-chat 或 Agent CLI 终端）', 'info');
        }
        ctx.closeMenu();
      },
    };
  });
}
