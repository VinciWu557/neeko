import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@/shared/store/editorStore';
import { useProjectStore } from '@/shared/store/projectStore';
import { useWorkspaceStore } from '@/shared/store/workspaceStore';

vi.mock('../../api/projectApi', () => ({
  setActiveProject: vi.fn().mockResolvedValue(undefined),
}));

import { useProjectSelection } from '../useProjectSelection';

describe('useProjectSelection.selectProject', () => {
  beforeEach(() => {
    useEditorStore.setState({ tabs: {}, editorLayout: {}, navigateGoal: null });
    useProjectStore.setState({ projects: [], activeProjectId: null, activeProject: null });
    useWorkspaceStore.setState({ byProject: {} });
  });

  it('选中项目写入 activeProjectId（全局 activeTabId 已删除，切项目不再需要同步它）', async () => {
    const { result } = renderHook(() => useProjectSelection());
    await act(async () => {
      await result.current.selectProject('p1');
    });

    expect(useProjectStore.getState().activeProjectId).toBe('p1');
  });
});
