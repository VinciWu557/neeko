/**
 * 模型列表的两个来源如何合并。
 *
 * ACP agent 的会话外快速路径返回空（`SessionScoped`），列表**只能**从会话内的
 * `configOptions` 取。不合并的话 ACP agent 的下拉永远是空的。
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { currentModelFromConfigOptions, modelsFromConfigOptions } from '@/shared/types/agentChat';

import { useModelsForPicker } from '../useModelsForPicker';

const modelOption = (currentValue: string | undefined) => ({
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: currentValue,
  options: [
    { value: 'a', name: 'Model A' },
    { value: 'b', name: 'Model B' },
  ],
});

describe('modelsFromConfigOptions', () => {
  it('should read options from the model entry', () => {
    expect(modelsFromConfigOptions([modelOption('a')]).map((m) => m.id)).toEqual(['a', 'b']);
  });

  /** `category` 缺失时按惯例 `id` 兜底（与后端同为三级定位）。 */
  it('should fall back to id when category is missing', () => {
    const noCategory = { ...modelOption('a'), category: undefined };
    expect(modelsFromConfigOptions([noCategory])).toHaveLength(2);
  });

  it('should return nothing when there is no model entry', () => {
    expect(modelsFromConfigOptions([{ id: 'mode', name: 'Mode', options: [] }])).toEqual([]);
    expect(modelsFromConfigOptions(undefined)).toEqual([]);
  });
});

describe('currentModelFromConfigOptions', () => {
  it('should read the current value', () => {
    expect(currentModelFromConfigOptions([modelOption('b')])).toBe('b');
  });

  /** 当前值缺失是正常情况（老 agent）—— 返回 undefined，不是错误。 */
  it('should return undefined when the current value is missing', () => {
    expect(currentModelFromConfigOptions([modelOption(undefined)])).toBeUndefined();
  });
});

describe('useModelsForPicker', () => {
  /** 会话内是权威来源。 */
  it('should prefer the session list over the catalog', () => {
    const { result } = renderHook(() =>
      useModelsForPicker([modelOption('a')], [{ id: 'catalog-1', name: 'Catalog' }]),
    );
    expect(result.current.map((m) => m.id)).toEqual(['a', 'b']);
  });

  /** 没有会话时回落到快速路径（opencode 的 `models --verbose`）。 */
  it('should fall back to the catalog before a session exists', () => {
    const { result } = renderHook(() =>
      useModelsForPicker([], [{ id: 'catalog-1', name: 'Catalog' }]),
    );
    expect(result.current.map((m) => m.id)).toEqual(['catalog-1']);
  });

  it('should be empty when neither source has models', () => {
    const { result } = renderHook(() => useModelsForPicker([], []));
    expect(result.current).toEqual([]);
  });
});
