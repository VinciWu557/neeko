// @vitest-environment node
/**
 * Action Palette 的 recent-prompt 投递（`libraryActionProvider`）。
 *
 * 本任务把 `insertToAgentInput` 从 `(text) => void` 改成返回 boolean，并要求
 * **调用方处理 false**（忽略返回值 = 重演「函数恒存在但静默 no-op」这条被修掉的 defect）。
 *
 * 用例面：投递成功不提示 / 投递被拒（false）必须提示 / 无 showToast 能力时不抛 /
 * recent 项与 prompt 本体一一对应（反死代码，见该用例注释）/ API 失败降级为空列表。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PromptResource } from '@/shared/types/library';

const { listPromptsMock } = vi.hoisted(() => ({ listPromptsMock: vi.fn() }));

vi.mock('@/features/library/api/libraryApi', () => ({
  listPrompts: (...args: unknown[]) => listPromptsMock(...args),
}));

import { getLibraryActionItems } from '../providers/libraryActionProvider';
import type { ActionContext } from '../types/actionMenu';

function prompt(overrides: Partial<PromptResource> = {}): PromptResource {
  return {
    id: 'p1',
    name: 'Review',
    content: 'review this diff',
    description: null,
    tags: [],
    scope: 'global',
    favorite: false,
    usageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    projectId: 'proj-1',
    tabKey: 'proj-1',
    agents: [],
    recentFiles: [],
    closeMenu: vi.fn(),
    insertToAgentInput: vi.fn(() => true),
    showToast: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  listPromptsMock.mockReset();
});

describe('getLibraryActionItems — recent prompt 投递', () => {
  it('列出 lastUsedAt 倒序的 recent 项（最多 5 条）', async () => {
    listPromptsMock.mockResolvedValue([
      prompt({ id: 'a', name: 'A', lastUsedAt: 1 }),
      prompt({ id: 'b', name: 'B', lastUsedAt: 9 }),
      prompt({ id: 'c', name: 'C', lastUsedAt: 0 }), // 从未使用 → 不进 recent
    ]);

    const items = await getLibraryActionItems(ctx());

    expect(items.map((i) => i.id)).toEqual(['recent-prompt-b', 'recent-prompt-a']);
    expect(items[0].label).toBe('💬 B');
  });

  it('执行时投递成功 → 不调 toast、关菜单', async () => {
    listPromptsMock.mockResolvedValue([prompt({ lastUsedAt: 5 })]);
    const insert = vi.fn(() => true);
    const closeMenu = vi.fn();
    const toast = vi.fn();
    const c = ctx({ insertToAgentInput: insert, closeMenu, showToast: toast });

    const [item] = await getLibraryActionItems(c);
    item.execute();

    expect(insert).toHaveBeenCalledWith('review this diff');
    expect(toast).not.toHaveBeenCalled();
    expect(closeMenu).toHaveBeenCalledTimes(1);
  });

  /** 本 defect 的反证：投递返回 false（无 composer 且无 Agent CLI tab）必须可见。 */
  it('agent 目标不可用（返回 false）→ 提示，不静默丢弃', async () => {
    listPromptsMock.mockResolvedValue([prompt({ lastUsedAt: 5 })]);
    const toast = vi.fn();
    const c = ctx({ insertToAgentInput: vi.fn(() => false), showToast: toast });

    const [item] = await getLibraryActionItems(c);
    item.execute();

    expect(toast).toHaveBeenCalledWith('无可用 agent 输入（agent-chat 或 Agent CLI 终端）', 'info');
  });

  /**
   * 反死代码：recent 项由 prompts 自身派生 ⇒ 「prompt 找不到」的分支不可达。
   * 本用例钉住这条推理（若将来改成持久化 recent 列表、真能出现孤儿项，它会红，
   * 提醒那时必须补上对应的用户反馈，而不是静默丢弃）。
   */
  it('每个 recent 项都能解析回 prompts 里的本体（无孤儿项）', async () => {
    listPromptsMock.mockResolvedValue([prompt({ id: 'x', name: 'X', lastUsedAt: 3 })]);
    const insert = vi.fn(() => true);
    const c = ctx({ insertToAgentInput: insert });

    const items = await getLibraryActionItems(c);
    items.forEach((item) => item.execute());

    expect(insert).toHaveBeenCalledTimes(items.length);
    expect(insert).toHaveBeenCalledWith('review this diff');
  });

  /** 无反馈能力时（宿主没给 showToast）不得抛 —— 菜单仍能正常关闭。 */
  it('showToast 缺省时不抛错', async () => {
    listPromptsMock.mockResolvedValue([prompt({ lastUsedAt: 5 })]);
    const c = ctx({ insertToAgentInput: vi.fn(() => false), showToast: undefined });

    const [item] = await getLibraryActionItems(c);

    expect(() => item.execute()).not.toThrow();
  });

  it('API 失败 → 返回空列表且不抛（palette 不该被 prompt 拉取失败打断）', async () => {
    listPromptsMock.mockRejectedValue(new Error('ipc down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getLibraryActionItems(ctx())).resolves.toEqual([]);
    errSpy.mockRestore();
  });
});
