// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { ProjectTabs, Tab } from '@/shared/types';
import { createDefaultEditorLayout } from '@/shared/types/editorGroup';

import {
  selectActiveTab,
  selectActiveTabId,
  selectOrderedTabIds,
  selectOrderedTabs,
  type EditorTabSpaceState,
} from '../editorTabSelectors';

const SPACE = 'p1\0';

function mkTab(id: string): Tab {
  return {
    id,
    scope: { kind: 'app' },
    title: id,
    data: { kind: 'file', filePath: id, fileName: id, content: '', isDirty: false },
  };
}

function stateWith(
  tabIds: string[],
  groups: { left: string[]; right: string[]; pinned: string[]; active: 'left' | 'right' },
): EditorTabSpaceState {
  const layout = createDefaultEditorLayout();
  layout.activeGroupId = groups.active;
  layout.isSplit = groups.right.length > 0;
  layout.groups.left = { tabIds: groups.left, activeTabId: groups.left[0] ?? null };
  layout.groups.right = { tabIds: groups.right, activeTabId: groups.right[0] ?? null };
  layout.pinnedTabIds = groups.pinned;
  layout.pinnedActiveTabId = groups.pinned[0] ?? null;
  const projectTabs: ProjectTabs = { tabs: tabIds.map(mkTab) };
  return { tabs: { [SPACE]: projectTabs }, editorLayout: { [SPACE]: layout } };
}

describe('selectOrderedTabIds / selectOrderedTabs', () => {
  it('顺序 = left → right → pinned（视觉顺序即仲裁顺序）', () => {
    const state = stateWith(['A', 'B', 'C', 'D', 'P'], {
      left: ['A', 'B'],
      right: ['C', 'D'],
      pinned: ['P'],
      active: 'right',
    });
    expect(selectOrderedTabIds(state, SPACE)).toEqual(['A', 'B', 'C', 'D', 'P']);
  });

  it('selectOrderedTabs 投影成 Tab 并保持顺序', () => {
    const state = stateWith(['A', 'B', 'C'], {
      left: ['C', 'A'],
      right: [],
      pinned: ['B'],
      active: 'left',
    });
    expect(selectOrderedTabs(state, SPACE).map((t) => t.id)).toEqual(['C', 'A', 'B']);
  });

  it('跳过 layout 里已失效的 id（heal 语义：关闭后残留的 id 不产出）', () => {
    const state = stateWith(['A', 'B'], {
      left: ['A', 'GONE'],
      right: ['B'],
      pinned: ['ALSO_GONE'],
      active: 'left',
    });
    expect(selectOrderedTabIds(state, SPACE)).toEqual(['A', 'GONE', 'B', 'ALSO_GONE']);
    expect(selectOrderedTabs(state, SPACE).map((t) => t.id)).toEqual(['A', 'B']);
  });

  it('未知空间 / 缺 layout → 空数组', () => {
    const empty: EditorTabSpaceState = { tabs: {}, editorLayout: {} };
    expect(selectOrderedTabIds(empty, 'missing')).toEqual([]);
    expect(selectOrderedTabs(empty, 'missing')).toEqual([]);
  });
});

describe('selectActiveTabId — 前台 = 激活编辑器组的激活 tab', () => {
  it('激活组为 left → 取 left 的 activeTabId', () => {
    const layout = createDefaultEditorLayout();
    layout.activeGroupId = 'left';
    layout.groups.left = { tabIds: ['A', 'B'], activeTabId: 'B' };
    layout.groups.right = { tabIds: ['C'], activeTabId: 'C' };
    const state: EditorTabSpaceState = {
      tabs: { [SPACE]: { tabs: [mkTab('A'), mkTab('B'), mkTab('C')] } },
      editorLayout: { [SPACE]: layout },
    };
    expect(selectActiveTabId(state, SPACE)).toBe('B');
  });

  it('换组 → 取该组的 activeTabId', () => {
    const layout = createDefaultEditorLayout();
    layout.activeGroupId = 'right';
    layout.groups.left = { tabIds: ['A'], activeTabId: 'A' };
    layout.groups.right = { tabIds: ['C'], activeTabId: 'C' };
    const state: EditorTabSpaceState = {
      tabs: { [SPACE]: { tabs: [mkTab('A'), mkTab('C')] } },
      editorLayout: { [SPACE]: layout },
    };
    expect(selectActiveTabId(state, SPACE)).toBe('C');
  });

  it('**pinned 激活态不影响组前台**（正交：pinned 是参照面板，不是当前工作 tab）', () => {
    const layout = createDefaultEditorLayout();
    layout.activeGroupId = 'left';
    layout.groups.left = { tabIds: ['A'], activeTabId: 'A' };
    layout.pinnedTabIds = ['P'];
    layout.pinnedActiveTabId = 'P';
    const state: EditorTabSpaceState = {
      tabs: { [SPACE]: { tabs: [mkTab('A'), mkTab('P')] } },
      editorLayout: { [SPACE]: layout },
    };
    expect(selectActiveTabId(state, SPACE)).toBe('A');
  });

  it('缺 layout / 未知空间 → null（优雅降级；I1 保证生产中不可达）', () => {
    const empty: EditorTabSpaceState = { tabs: {}, editorLayout: {} };
    expect(selectActiveTabId(empty, SPACE)).toBeNull();
    expect(selectActiveTabId(empty, 'missing')).toBeNull();
  });
});

describe('selectActiveTab — 前台 Tab 对象', () => {
  it('返回激活组的激活 tab 对象；已失效 id → null', () => {
    const layout = createDefaultEditorLayout();
    layout.activeGroupId = 'left';
    layout.groups.left = { tabIds: ['A', 'B'], activeTabId: 'B' };
    const state: EditorTabSpaceState = {
      tabs: { [SPACE]: { tabs: [mkTab('A'), mkTab('B')] } },
      editorLayout: { [SPACE]: layout },
    };
    expect(selectActiveTab(state, SPACE)?.id).toBe('B');

    // 激活位指向已从注册表移除的 id → null（不产出幽灵 tab）
    layout.groups.left = { tabIds: ['A'], activeTabId: 'GONE' };
    const stale: EditorTabSpaceState = {
      tabs: { [SPACE]: { tabs: [mkTab('A')] } },
      editorLayout: { [SPACE]: layout },
    };
    expect(selectActiveTab(stale, SPACE)).toBeNull();
  });
});
