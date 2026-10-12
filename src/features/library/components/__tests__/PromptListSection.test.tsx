import { fireEvent, render as renderRTL, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLibraryStore } from '@/features/library/store/libraryStore';
import type { PromptResource } from '@/shared/types/library';
import { createAppProviderWrapper } from '@/testing/AppProviderTestUtils';

import PromptListSection from '../PromptListSection';

/** 行内复制按钮依赖 useAppContext（useCopyToClipboard），故需要 AppProvider 包装。 */
const render = (ui: Parameters<typeof renderRTL>[0]) =>
  renderRTL(ui, { wrapper: createAppProviderWrapper() });

function makePrompt(name: string, overrides: Partial<PromptResource> = {}): PromptResource {
  return {
    id: `id-${name}`,
    name,
    content: `content of ${name}`,
    tags: [],
    scope: 'global',
    favorite: false,
    usageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('PromptListSection — 删除流', () => {
  beforeEach(() => {
    useLibraryStore.setState({
      prompts: [makePrompt('Alpha')],
      promptsLoading: false,
      searchQuery: '',
      tagFilter: [],
      scopeFilter: 'all',
      viewMode: 'list',
      sortMode: 'recent',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('点击删除 → 弹确认框（含名称）→ 确认调用 deletePrompt', async () => {
    const deletePrompt = vi
      .spyOn(useLibraryStore.getState(), 'deletePrompt')
      .mockResolvedValue(undefined);
    render(<PromptListSection />);

    fireEvent.click(screen.getByTitle('Delete'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete prompt?')).toBeInTheDocument();
    expect(within(dialog).getByText('Alpha')).toBeInTheDocument();
    expect(deletePrompt).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deletePrompt).toHaveBeenCalledWith('id-Alpha'));
  });

  it('取消确认框 → 不删除', async () => {
    const deletePrompt = vi
      .spyOn(useLibraryStore.getState(), 'deletePrompt')
      .mockResolvedValue(undefined);
    render(<PromptListSection />);

    fireEvent.click(screen.getByTitle('Delete'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(deletePrompt).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
