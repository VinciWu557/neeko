// @vitest-environment node
/**
 * reflow 路由表单测：deep link → 既有 selectProject/activateTab 路径。
 * （铁律验证：回流不新造「打开会话」逻辑，只编排两个既有 store action。）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const activateTab = vi.fn();
const selectProject = vi.fn();

vi.mock('@/shared/store/editorStore', () => ({
  useEditorStore: {
    getState: () => ({
      tabs: {
        'ws-1': {
          tabs: [
            {
              id: 't1',
              title: 'Terminal',
              scope: { kind: 'app' },
              data: { kind: 'terminal' },
            },
            {
              id: 't2',
              title: 'Chat',
              scope: { kind: 'workspace', session: { key: 'ws-1', projectId: 'p-9' } },
              data: { kind: 'agent-chat', sessionId: 'sess-42' },
            },
          ],
        },
      },
      activateTab,
    }),
  },
}));

vi.mock('@/shared/store/projectStore', () => ({
  useProjectStore: { getState: () => ({ selectProject }) },
}));

import { reflowFromDeepLink } from '../reflow';

describe('reflowFromDeepLink', () => {
  beforeEach(() => {
    activateTab.mockReset();
    selectProject.mockReset();
  });

  /** agent 域：命中会话 → 先切项目再激活 tab（复用既有路径，顺序即产品语义）。 */
  it('routes agent deep link to selectProject + activateTab', () => {
    expect(reflowFromDeepLink('neeko://agent/sess-42')).toBe(true);
    expect(selectProject).toHaveBeenCalledWith('p-9');
    expect(activateTab).toHaveBeenCalledWith('ws-1', 't2');
  });

  /** 会话已关闭（找不到 tab）→ false，调用方静默降级。 */
  it('returns false when session tab no longer exists', () => {
    expect(reflowFromDeepLink('neeko://agent/gone')).toBe(false);
    expect(selectProject).not.toHaveBeenCalled();
    expect(activateTab).not.toHaveBeenCalled();
  });

  /** 未知 domain / 畸形链接 → false（路由表未登记，不抛错不越权）。 */
  it('ignores unknown domains and malformed links', () => {
    expect(reflowFromDeepLink('neeko://git/rebase-1')).toBe(false);
    expect(reflowFromDeepLink('https://example.com')).toBe(false);
    expect(reflowFromDeepLink('')).toBe(false);
  });
});
