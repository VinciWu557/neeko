/**
 * 「选哪个模型」的三条优先序。
 *
 * 第一条最容易被忽略也最危险：agent 会主动换模型（rate limit fallback），此时
 * `configOptions.current_value` 是权威。UI 不跟上就会出现「显示 A、实际跑 B」——
 * 用户完全无从察觉。
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSelectedModelSync } from '../useSelectedModelSync';

const m = (id: string) => ({ id, name: id });
const models = [m('a'), m('b')];
const configWith = (currentValue: string) => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: currentValue,
    options: [],
  },
];

describe('useSelectedModelSync', () => {
  /** agent 主动换模型 → UI 必须跟上，哪怕用户之前选的是别的。 */
  it('should follow the session current value over the user selection', () => {
    const setSelected = vi.fn();
    renderHook(() => useSelectedModelSync(models, configWith('b'), m('a'), setSelected));
    expect(setSelected).toHaveBeenCalledWith(models[1]);
  });

  /** 用户的选择仍在列表里 → 不覆盖（否则选一次就被默认值顶掉）。 */
  it('should keep the user selection when it is still available', () => {
    const setSelected = vi.fn();
    renderHook(() => useSelectedModelSync(models, configWith('a'), m('a'), setSelected));
    expect(setSelected).not.toHaveBeenCalled();
  });

  /** 都没有 → 落到 agent 下发的首个。 */
  it('should fall back to the first model', () => {
    const setSelected = vi.fn();
    renderHook(() => useSelectedModelSync(models, [], null, setSelected));
    expect(setSelected).toHaveBeenCalledWith(models[0]);
  });

  /**
   * **线上字段名是 `currentValue`（camelCase）** —— 后端 `#[serde(rename)]` 同时作用于
   * 读和写。前端若写成 `current_value`，TS 不会报错（两端独立声明），但运行时该字段
   * 恒为 `undefined`，于是「会话当前值优先」从上线起就静默失效。
   *
   * 这条用**后端真实发出的形状**构造，不是用前端类型的字段名 —— 后者测的是
   * 「我的类型定义对不对」，而不是「协议对不对」。
   */
  it('should read the camelCase wire field currentValue', () => {
    const wireShape = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'b',
        options: [],
      },
    ] as unknown as Parameters<typeof useSelectedModelSync>[1];

    const setSelected = vi.fn();
    renderHook(() => useSelectedModelSync(models, wireShape, m('a'), setSelected));
    expect(setSelected).toHaveBeenCalledWith(models[1]);
  });

  /** 列表为空时不动作（避免 setSelected(undefined)）。 */
  it('should do nothing when there are no models', () => {
    const setSelected = vi.fn();
    renderHook(() => useSelectedModelSync([], [], null, setSelected));
    expect(setSelected).not.toHaveBeenCalled();
  });
});
