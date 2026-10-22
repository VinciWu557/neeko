import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

/** 真实样式表源码 —— 「高亮」必须在仓库里真的有规则，不只是挂个 class。 */
const AGENT_CHAT_CSS = readFileSync(
  resolve(process.cwd(), 'src/styles/components/agent-chat.css'),
  'utf-8',
);

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

  /**
   * 选中项必须有**视觉**高亮，而不只是挂一个没人消费的 class。
   *
   * `ModelList` 一直在算 `selected` 类，但样式表里从未有过 `.param-option.selected`
   * 规则 —— 类名写了、零消费，等于没有高亮（与 `isSelectable()` 那次同型的
   * 「写了却没人用」）。这条断言同时钉住两侧：class 真的落在选中那一项上 +
   * 样式表真的有对应规则。
   */
  it('should mark the selected item and style it', () => {
    const models = Array.from({ length: 5 }, (_, i) =>
      makeModel({ id: `model-${i}`, name: `Model ${i}` }),
    );
    render(<ModelPicker models={models} selected={models[2]} onChange={() => {}} agent={AGENT} />);
    fireEvent.click(screen.getByRole('button', { name: /Model 2/i }));

    // 列表项现在是 `role="option"`（可访问性语义），不再以 button 角色暴露。
    const options = screen.getAllByRole('option');
    const selectedOption = options.find((o) => o.textContent?.includes('Model 2'));
    expect(selectedOption).toHaveClass('selected');
    // 同一判据必须同时驱动 class 与 aria —— 两者分开推导就会漂移
    expect(selectedOption).toHaveAttribute('aria-selected', 'true');
    // 其它条目不能被误标（class 与 aria 都要干净）
    const other = options.find((o) => o.textContent?.includes('Model 3'));
    expect(other).not.toHaveClass('selected');
    expect(other).toHaveAttribute('aria-selected', 'false');

    // 样式表必须真的给这个 class 上色 —— 否则「高亮」只是注释里的愿望
    expect(AGENT_CHAT_CSS).toMatch(/\.param-option\.selected\s*\{[^}]*background/);
    // 选中项的模型名要有可辨识颜色（只改背景在深色主题下太弱）
    expect(AGENT_CHAT_CSS).toMatch(/\.param-option\.selected\s+\.param-opt-name\s*\{[^}]*color/);
  });

  /**
   * 聚焦搜索框**不能**把列表滚回去。
   *
   * `ModelPicker` 打开后 50ms 聚焦搜索框；不传 `preventScroll` 时浏览器会把获得
   * 焦点的元素滚进视口 —— 搜索框在列表顶部，于是刚 `scrollIntoView` 到中间的选中项
   * 被顶掉，用户看到的仍是列表开头。这正是「自动定位没生效」的根因：滚动发生了，
   * 只是紧接着被聚焦抵消。
   *
   * 变异验证：把 `focus()` 改回无参 → 本用例变红。
   */
  it('should focus the search box without scrolling the list back', async () => {
    const focusSpy = vi.spyOn(HTMLInputElement.prototype, 'focus');
    // 断言失败也必须还原 —— 否则 `focus` 被永久 stub，后续用例的聚焦行为全变。
    try {
      const models = Array.from({ length: 60 }, (_, i) =>
        makeModel({ id: `model-${i}`, name: `Model ${i}` }),
      );

      render(
        <ModelPicker models={models} selected={models[42]} onChange={() => {}} agent={AGENT} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Model 42/i }));

      // 等过 50ms 的聚焦定时器
      await vi.waitFor(() => expect(focusSpy).toHaveBeenCalled());
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      focusSpy.mockRestore();
    }
  });
});
