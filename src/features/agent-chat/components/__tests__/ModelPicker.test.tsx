import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ModelInfo } from '@/features/agent/api/agentApi';

import { ModelPicker } from '../ModelPicker';

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'model-1',
    name: 'Sonnet',
    supported_reasoning_efforts: ['low', 'high'],
    is_free: false,
    ...overrides,
  };
}

function makeAgent(icon: string | null, name = 'Claude Code') {
  return { id: 'a1', name, icon };
}

describe('ModelPicker 显示模型自己的厂商图标', () => {
  /**
   * 列表里每一项是**模型**，不是 agent —— 同一个 agent（Pi）能挂 15 个 provider
   * 的 224 个模型，全显示 agent logo 等于没有信息量。
   */
  it('列表项按模型厂商显示图标，而不是 agent 图标', () => {
    render(
      <ModelPicker
        models={[
          makeModel({ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }),
          makeModel({ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }),
        ]}
        selected={null}
        onChange={() => {}}
        agent={makeAgent('qoder.svg', 'Qoder')}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Select model|Sonnet|DeepSeek/i }));

    // Claude 命中 anthropic 品牌资源
    const claude = screen.getByRole('img', { name: 'anthropic' });
    expect(claude).toHaveAttribute('src', expect.stringContaining('claude-code.png'));
    // 列表项里：Claude 有品牌资源（1 个 logo），DeepSeek 走语义兜底（无 logo）
    expect(screen.getAllByRole('img', { name: 'anthropic' })).toHaveLength(1);
    // agent 的 Qoder 图标最多出现在主按钮上（未选模型），**不在列表项里**
    const qoderImgs = screen.queryAllByRole('img', { name: 'Qoder' });
    expect(qoderImgs).toHaveLength(1);
    // eslint-disable-next-line testing-library/no-node-access -- 结构关系断言（图标属于哪个列表项）必须用 closest
    expect(qoderImgs[0].closest('.param-option')).toBeNull();
  });

  /** 认不出厂商 → 中性 `Box` 图标（实测 19% 的模型属于这一类）。 */
  it('认不出厂商时降级为中性图标', () => {
    const { container } = render(
      <ModelPicker
        models={[makeModel({ id: 'space-bunny-free', name: 'Space Bunny Free' })]}
        selected={null}
        onChange={() => {}}
        agent={makeAgent('claude-code.png')}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    // 未选模型时主按钮仍显示 agent 图标（正确行为），所以按数量断言：
    // 全场只有主按钮那 1 个 logo，列表项走的是中性兜底。
    expect(screen.getAllByRole('img')).toHaveLength(1);
    // 兜底图标是 lucide SVG，没有 role/name —— 只能按 class 断言（`no-container` 无替代）
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    expect(container.querySelector('svg.lucide-box')).not.toBeNull();
  });

  /** 还没选模型（会话未建）时按钮回落到 agent 图标 —— 那是它唯一有意义的身份。 */
  it('未选模型时按钮回落到 agent 图标', () => {
    render(
      <ModelPicker
        models={[makeModel()]}
        selected={null}
        onChange={() => {}}
        agent={makeAgent('claude-code.png')}
      />,
    );

    const btn = screen.getByRole('button', { name: /Select model/i });
    const img = within(btn).getByRole('img', { name: 'Claude Code' });
    expect(img).toHaveAttribute('src', expect.stringContaining('claude-code.png'));
  });
});
