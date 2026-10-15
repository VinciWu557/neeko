// @vitest-environment node
// Regression test: closing the active tab must move the layout
// group activeTabId onto a live tab. Runs against the real production
// code path (`closeEditorTab` → store) WITHOUT React rendering, so the
// store/layout invariants are checked directly.
import { beforeEach, describe, expect, it } from 'vitest';

import { closeEditorTab } from '@/features/terminal';
import { activeTabIdOf, useEditorStore } from '@/shared/store/editorStore';
import type { Tab } from '@/shared/types';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

const SPACE_p1 = WorkspaceSession.of('p1', null).key;

/** 测试身份源：项目 id → WorkspaceSession（主仓形态）。 */
function mkSession(projectId: string) {
  return WorkspaceSession.of(projectId, null);
}

function makeTab(id: string): Tab {
  return {
    id,
    scope: { kind: 'workspace', session: mkSession('p1') },
    title: id,
    data: { kind: 'file', filePath: id, fileName: id, content: '', isDirty: false },
  };
}

describe('closeTab prod parity (no React rendering needed — pure store)', () => {
  beforeEach(() => {
    useEditorStore.setState({ tabs: {}, editorLayout: {} });
  });

  it('single group: closing active tab keeps left group active on a live tab', () => {
    const { addTab, activateTab } = useEditorStore.getState();
    addTab(makeTab('A'));
    addTab(makeTab('B'));
    addTab(makeTab('C'));
    activateTab(SPACE_p1, 'B');

    closeEditorTab(SPACE_p1, 'B');

    const s = useEditorStore.getState();
    const layout = s.editorLayout[SPACE_p1];
    expect(layout.groups.left.tabIds).toEqual(['A', 'C']);
    expect(layout.groups.left.activeTabId).toBe('A');
    expect(layout.groups.left.tabIds).toContain(layout.groups.left.activeTabId);
    expect(activeTabIdOf(SPACE_p1)).toBe('A');
  });

  it('single group: closing active tab that is the FIRST tab switches forward', () => {
    const { addTab, activateTab } = useEditorStore.getState();
    addTab(makeTab('A'));
    addTab(makeTab('B'));
    activateTab(SPACE_p1, 'A');

    closeEditorTab(SPACE_p1, 'A');

    const s = useEditorStore.getState();
    expect(s.editorLayout[SPACE_p1].groups.left.activeTabId).toBe('B');
    expect(activeTabIdOf(SPACE_p1)).toBe('B');
  });

  it('single group: closing the LAST tab leaves a valid active tab', () => {
    const { addTab, activateTab } = useEditorStore.getState();
    addTab(makeTab('A'));
    addTab(makeTab('B'));
    activateTab(SPACE_p1, 'B');

    closeEditorTab(SPACE_p1, 'B');

    const s = useEditorStore.getState();
    expect(s.editorLayout[SPACE_p1].groups.left.activeTabId).toBe('A');
    expect(activeTabIdOf(SPACE_p1)).toBe('A');
  });

  it('layout missing (undefined editorLayout): closeTab still yields a consistent layout', () => {
    // 不变量 I1（有 tab 必有 layout）成立后本形态不可达，保留作防御：无 layout 时
    // 删/关 tab 必须仍产出一份自洽的 layout（此前那处 `tabs[key].activeTabId` 已删除）。
    useEditorStore.setState({
      tabs: { [SPACE_p1]: { tabs: [makeTab('A'), makeTab('B'), makeTab('C')] } },
      editorLayout: {},
    });

    closeEditorTab(SPACE_p1, 'B');

    const s = useEditorStore.getState();
    expect(s.tabs[SPACE_p1].tabs.map((t) => t.id)).toEqual(['A', 'C']);
    // 缺 layout 时 closeTab 兜底建一份：前台必落在**存活** tab 上（不再依赖已删除的投影）。
    const foreground = activeTabIdOf(SPACE_p1);
    expect(foreground).not.toBeNull();
    expect(['A', 'C']).toContain(foreground);
  });
});
