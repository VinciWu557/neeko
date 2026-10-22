import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ModelInfo } from '@/features/agent/api/agentApi';
import type { SessionConfigOption } from '@/shared/types/agentChat';

vi.mock('@/features/agent', () => ({
  useAgentModels: () => ({ models: [], status: 'unsupported' }),
}));

import { useModelSelection } from '../useModelSelection';

const MODEL_OPTION: SessionConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'deepseek-flash',
  options: [
    { value: 'deepseek-flash', name: 'deepseek-flash' },
    { value: 'deepseek-pro', name: 'deepseek-pro' },
  ],
};

const CATALOG_MODEL: ModelInfo = {
  id: 'anthropic/claude-sonnet',
  name: 'anthropic/claude-sonnet',
};

function setup(params: {
  sessionConfigOptions: SessionConfigOption[];
  availability: 'no-config' | 'per-turn' | 'pending' | 'ready';
}) {
  const setConfigOption = vi.fn();
  const setSelectedModel = vi.fn();
  const hook = renderHook(() =>
    useModelSelection({
      agentId: 'a',
      sessionConfigOptions: params.sessionConfigOptions,
      availability: params.availability,
      selectedModel: null,
      setSelectedModel,
      setConfigOption,
    }),
  );
  return { ...hook, setConfigOption, setSelectedModel };
}

describe('useModelSelection — 写回路径', () => {
  /** 会话内（`ready`）列表：走 `set_config_option`，value 是裸名。 */
  it('should push a session model through set_config_option', () => {
    const { result, setConfigOption } = setup({
      sessionConfigOptions: [MODEL_OPTION],
      availability: 'ready',
    });
    act(() => result.current.selectModel({ id: 'deepseek-pro', name: 'deepseek-pro' }));
    expect(setConfigOption).toHaveBeenCalledWith('model', 'deepseek-pro');
  });

  /** serve（`per_turn`）：**不发** `set_config_option`，写回在下一轮 `Turn` 上。 */
  it('should not call set_config_option for a per_turn transport', () => {
    const { result, setConfigOption, setSelectedModel } = setup({
      sessionConfigOptions: [],
      availability: 'per-turn',
    });
    act(() => result.current.selectModel(CATALOG_MODEL));
    expect(setConfigOption).not.toHaveBeenCalled();
    // 本地仍要响应 —— 它让下一次 `Turn` 带上 `model_id`。
    expect(setSelectedModel).toHaveBeenCalledWith(CATALOG_MODEL);
  });

  /**
   * **关键**：`per_turn` 传输即便会话里残留了 model 配置项，也不能把目录 id
   * 塞进 `set_config_option` —— serve 的那个分支是空实现 `{}`。
   */
  it('should not write through a stale config option on a per_turn transport', () => {
    const { result, setConfigOption } = setup({
      sessionConfigOptions: [MODEL_OPTION],
      availability: 'per-turn',
    });
    act(() => result.current.selectModel(CATALOG_MODEL));
    expect(setConfigOption).not.toHaveBeenCalled();
  });

  /**
   * Pi 表格 + `session_config` + **会话未建立**（`loading`）→ 不可写。
   *
   * 这是 `read_only` 分支原来是运行期告警的那条路径。现在它由
   * `modelWriteOf` 返回 `null`，**且渲染层已禁用列表**（同一个
   * `modelSourceOf`）—— 用户不会走到这里。
   */
  it('should ignore a selection when the list is display-only', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result, setConfigOption, setSelectedModel } = setup({
      sessionConfigOptions: [],
      availability: 'pending',
    });
    act(() => result.current.selectModel(CATALOG_MODEL));
    expect(setConfigOption).not.toHaveBeenCalled();
    // 本地仍响应（不阻塞 UI），但有日志可查。
    expect(setSelectedModel).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  /** `none` 传输永远不可写，无论 phase。 */
  it('should never write for a transport without session config', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result, setConfigOption } = setup({
      sessionConfigOptions: [MODEL_OPTION],
      availability: 'no-config',
    });
    act(() => result.current.selectModel(CATALOG_MODEL));
    expect(setConfigOption).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
