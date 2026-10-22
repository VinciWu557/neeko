import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ModelInfo } from '@/features/agent/api/agentApi';

import { ModelPicker } from '../ModelPicker';

/**
 * 打开下拉时必须**滚动到选中项**。
 *
 * Pi 实测 165~179 条模型，选中项常在列表深处。只做高亮而不滚动，用户每次打开
 * 都要自己找一遍 —— 在 165 条里找一个 `deepseek-v4-pro` 是几十次滚轮。
 */

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return { id: 'm', name: 'Model', supported_reasoning_efforts: [], is_free: false, ...overrides };
}

const AGENT = { id: 'pi', name: 'Pi', icon: null };

describe('ModelPicker 打开时定位选中项', () => {
  it('should scroll the selected item into view when the dropdown opens', () => {
    const scrollSpy = vi.fn();
    // jsdom 不实现 scrollIntoView。挂在 `HTMLElement.prototype`（`Element` 上那份
    // 不会被 `<button>` 命中），并记录调用者，才能断言「滚的是选中项」。
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrollSpy(this);
    };

    const models = Array.from({ length: 60 }, (_, i) =>
      makeModel({ id: `model-${i}`, name: `Model ${i}` }),
    );
    const selected = models[42];

    render(<ModelPicker models={models} selected={selected} onChange={() => {}} agent={AGENT} />);
    expect(scrollSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Model 42/i }));

    expect(scrollSpy).toHaveBeenCalled();
    // 被滚动的必须是**选中的那一项**，不是列表首项
    const target = scrollSpy.mock.calls[0]?.[0] as HTMLElement | undefined;
    expect(target?.textContent).toContain('Model 42');
  });
});
