/**
 * 模型列表的**来源选择**必须由 `availability` 唯一决定。
 *
 * 旧实现自己数 `options.length > 0`，与 `modelWriteOf` 的判据形成第二个派生点 ——
 * 实测 10 种组合里 8 种「展示的列表」与「写回目标的语义」不一致。
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ModelInfo } from '@/features/agent/api/agentApi';
import type { SessionConfigOption } from '@/shared/types/agentChat';

import { useModelsForPicker } from '../useModelsForPicker';

const SESSION_MODELS: SessionConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'deepseek-flash',
    options: [
      { value: 'deepseek-flash', name: 'deepseek-flash' },
      { value: 'deepseek-pro', name: 'deepseek-pro' },
    ],
  },
];

const CATALOG: ModelInfo[] = [
  { id: 'anthropic/claude-sonnet', name: 'claude-sonnet', group: 'anthropic' },
];

function pick(
  availability: 'no-config' | 'per-turn' | 'pending' | 'ready',
  options: SessionConfigOption[],
) {
  return renderHook(() => useModelsForPicker(availability, options, CATALOG)).result.current;
}

describe('useModelsForPicker — 来源由 availability 唯一决定', () => {
  /**
   * `ready` + 有会话内选项 → **会话内**（权威裸名，写回走 `config_value`）。
   */
  it('should use the session list when the session is ready', () => {
    const models = pick('ready', SESSION_MODELS);
    expect(models.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-pro']);
  });

  /**
   * `ready` + 会话内**没有**模型项 → **空列表，不退回目录**。
   *
   * `ready` 的写回通道是 `config_value`（要裸名），而目录 id 是
   * `provider/model` 复合串 —— 展示出来就是「能点但切不动」（R3 禁止）。
   * 宁可不显示：空列表 + 空态文案比一串点不动的模型诚实。
   *
   * 变异验证：改成 `return fromSession.length > 0 ? fromSession : catalogModels`
   * → 本用例变红。
   */
  it('should show nothing rather than unwritable catalog rows when a ready session has no models', () => {
    expect(pick('ready', [])).toEqual([]);
  });

  /**
   * **关键**：`per-turn`（serve）即便会话里有残留选项，也必须用**目录**。
   *
   * 它的写回走 `Turn { model_id }`，id 语义是 `provider/model` 复合串。
   * 用会话内的裸名会让 `model_slug_split` 拆出空 provider。
   *
   * 变异验证：把判据改回 `options.length > 0` → 本用例变红。
   */
  it('should use the catalog for a per_turn transport even with stale session options', () => {
    expect(pick('per-turn', SESSION_MODELS).map((m) => m.id)).toEqual(['anthropic/claude-sonnet']);
  });

  /** `pending` 同理：会话没就绪，残留选项不能当权威列表。 */
  it('should use the catalog while the session is pending', () => {
    expect(pick('pending', SESSION_MODELS).map((m) => m.id)).toEqual(['anthropic/claude-sonnet']);
  });

  /** `no-config` 传输只有目录（可能为空）。 */
  it('should use the catalog for a transport without session config', () => {
    expect(pick('no-config', []).map((m) => m.id)).toEqual(['anthropic/claude-sonnet']);
  });

  /**
   * **不变量**：只有 `ready` 才可能返回会话内列表 —— 因为只有它的写回语义
   * （`config_value`）与裸名 id 匹配。其余状态一律目录。
   */
  it('should return session models only in the ready state', () => {
    const states = ['no-config', 'per-turn', 'pending', 'ready'] as const;
    for (const a of states) {
      const ids = pick(a, SESSION_MODELS).map((m) => m.id);
      const isSession = ids.includes('deepseek-flash');
      expect(isSession).toBe(a === 'ready');
    }
  });
});
