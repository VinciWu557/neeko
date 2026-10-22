import { describe, expect, it } from 'vitest';

import { displayName, providerLabelOf } from '../constants';

/**
 * 模型名 / provider 的展示派生规则。
 *
 * 这两个函数都是**纯函数**，按仓库红线要求 100% 覆盖 —— 包括各自的「不命中」分支。
 */

describe('displayName', () => {
  /** 唯一的历史改名：`deepseek-harness` 这个 id 对用户没有意义。 */
  it('maps the harness id to its product name', () => {
    expect(displayName('deepseek-harness')).toBe('deepseek');
  });

  /** 其余名字原样返回 —— 不得擅自改写厂商大小写或拼写。 */
  it('leaves every other name untouched', () => {
    expect(displayName('Deepseek-V4.1-Flash')).toBe('Deepseek-V4.1-Flash');
    expect(displayName('claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(displayName('')).toBe('');
  });
});

/**
 * 按钮上要显示 provider —— 但**只在它是额外信息时**。
 *
 * 两种 agent 的 provider 位置不同，这是本函数存在的全部理由：
 *
 * | 来源 | `name` | `group` |
 * | --- | --- | --- |
 * | Pi `get_available_models`（rpc，活路径） | `Deepseek-V4.1-Flash` | `magpie` |
 * | opencode `models --verbose` | `opencode/big-pickle` | — |
 * | 旧版 Pi CLI 表格（已删除） | `magpie/deepseek-v4.1-flash` | `magpie` |
 *
 * 后两行 provider 已在 `name` 里，再拼一遍就是 `magpie/magpie/...` 式噪音。
 */
describe('providerLabelOf', () => {
  it('Pi 的 rpc 列表：name 不含 provider → 单独返回它', () => {
    expect(providerLabelOf({ name: 'Deepseek-V4.1-Flash', group: 'magpie' })).toBe('magpie');
  });

  /** 旧版 Pi 表格路径把 provider 拼进了 name，再显示一次是重复。 */
  it('name 已含 provider → 不重复显示', () => {
    expect(
      providerLabelOf({ name: 'magpie/deepseek-v4.1-flash', group: 'magpie' }),
    ).toBeUndefined();
  });

  /** 大小写不参与判定 —— `Magpie/...` 与 `magpie` 是同一个 provider。 */
  it('大小写不同也算已包含', () => {
    expect(providerLabelOf({ name: 'Magpie/Deepseek', group: 'magpie' })).toBeUndefined();
  });

  /**
   * **反例**：名字里恰好出现 provider 字样，但它不是复合串的前缀。
   *
   * 用 `includes` 判定时这里会被误判成重复 → provider 被藏起来，而它正是
   * 「同名模型散落在多个 provider 下」时唯一能分辨的信息。
   */
  it('名字里含 provider 字样但不是前缀 → 仍然显示', () => {
    expect(providerLabelOf({ name: 'DeepSeek V4 Pro', group: 'deepseek' })).toBe('deepseek');
  });

  /** opencode 没有独立分组维度（provider 已并入 name），字段缺失是正常形状。 */
  it('无 group → undefined（不是空串）', () => {
    expect(providerLabelOf({ name: 'opencode/big-pickle' })).toBeUndefined();
  });

  /** 空白 group 等于没有 —— 否则会渲染一个空的 provider 徽标。 */
  it('group 只有空白 → undefined', () => {
    expect(providerLabelOf({ name: 'Deepseek', group: '   ' })).toBeUndefined();
  });

  /** group 前后空白要被 trim 掉 —— 线上字段偶带空格时不该显示成 ` magpie `。 */
  it('group 前后空白被 trim', () => {
    expect(providerLabelOf({ name: 'Deepseek', group: '  magpie  ' })).toBe('magpie');
  });
});
