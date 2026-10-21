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

  /**
   * **切推理档位不得改模型**（真机缺陷）。
   *
   * 后端 `refresh_configs` 在切档位后会重拉整份 configOptions —— 因为档位的可选项
   * 随模型变化，必须重拉。但模型项的 `current_value` 只是**原样重报**一次会话当前值，
   * 那不是「agent 换了模型」。
   *
   * 旧实现把它当成权威，于是：用户选了模型 B（还没发消息）→ 切档位 → 一次无关的
   * 刷新把模型打回会话当前值 A。表现就是「选完模型再选思考等级，模型自己变了」。
   */
  it('should not override the user selection when an unrelated refresh repeats the current value', () => {
    const setSelected = vi.fn();
    // 关键：`selectedModel` 必须是用户新选的 **B**，而会话当前值仍是 **A**。
    // 若这里用 A，`alreadySelected` 会挡住覆盖，测试就抓不到缺陷（已实测确认）。
    const { rerender } = renderHook(
      ({ opts, sel }) => useSelectedModelSync(models, opts, sel, setSelected),
      { initialProps: { opts: configWith('a'), sel: m('a') } },
    );

    // 1) 首帧建立「已知当前值 = a」
    // 2) 用户选了 B（还没发消息）
    rerender({ opts: configWith('a'), sel: m('b') });
    setSelected.mockClear();

    // 3) 切推理档位：configOptions 换了一份新数组，模型项 current_value 仍是 'a'
    const afterLevelSwitch = [
      ...configWith('a'),
      {
        id: 'thinking_level',
        name: 'Thinking level',
        category: 'thought_level',
        currentValue: 'low',
        options: [
          { value: 'low', name: 'low' },
          { value: 'high', name: 'high' },
        ],
      },
    ];
    rerender({ opts: afterLevelSwitch, sel: m('b') });

    // 会话当前模型没变（仍是 a）→ **不得**把用户选的 B 打回去
    expect(setSelected).not.toHaveBeenCalled();
  });

  /** agent 主动换模型（current_value 真的变了）→ 必须跟上。 */
  it('should follow when the agent actually switches the model', () => {
    const setSelected = vi.fn();
    const { rerender } = renderHook(
      ({ opts }) => useSelectedModelSync(models, opts, m('a'), setSelected),
      { initialProps: { opts: configWith('a') } },
    );
    setSelected.mockClear();

    // rate-limit fallback：会话当前值从 a 变成 b
    rerender({ opts: configWith('b') });
    expect(setSelected).toHaveBeenCalledWith(models[1]);
  });

  /** 列表为空时不动作（避免 setSelected(undefined)）。 */
  it('should do nothing when there are no models', () => {
    const setSelected = vi.fn();
    renderHook(() => useSelectedModelSync([], [], null, setSelected));
    expect(setSelected).not.toHaveBeenCalled();
  });
});
