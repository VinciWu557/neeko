import { describe, expect, it } from 'vitest';

import type { ModelInfo } from '@/shared/types/agent';

import {
  modelAvailabilityOf,
  hasModelId,
  modelKeyOf,
  modelWriteOf,
  resolveModelById,
  showsConfigControls,
  showsModelPicker,
  writabilityOf,
  type ModelAvailability,
} from '../modelTarget';

function model(id: string, group?: string): ModelInfo {
  return { id, name: id, group };
}

const ALL_STATES: ModelAvailability[] = ['no-config', 'per-turn', 'pending', 'ready'];

describe('modelAvailabilityOf — 唯一合成入口', () => {
  /** `none` 传输永远 `no-config`，**即便 phase 报 ready**（那只能是残留选项）。 */
  it.each(['unsupported', 'loading', 'ready'] as const)(
    'should map a none transport to no-config regardless of phase %s',
    (phase) => {
      expect(modelAvailabilityOf('none', phase)).toBe('no-config');
    },
  );

  /** `per_turn` 传输永远 `per-turn`，与 phase 无关（serve 没有配置项通道）。 */
  it.each(['unsupported', 'loading', 'ready'] as const)(
    'should map a per_turn transport to per-turn regardless of phase %s',
    (phase) => {
      expect(modelAvailabilityOf('per_turn', phase)).toBe('per-turn');
    },
  );

  /** `session_config` + 就绪 → `ready`；未就绪 → `pending`（暂时）。 */
  it('should split session_config by readiness', () => {
    expect(modelAvailabilityOf('session_config', 'ready')).toBe('ready');
    expect(modelAvailabilityOf('session_config', 'loading')).toBe('pending');
    expect(modelAvailabilityOf('session_config', 'unsupported')).toBe('pending');
  });

  /**
   * **9 种输入只产出 4 种状态** —— 这就是把笛卡尔积收成 union 的意义：
   * `{phase:'ready', capability:'none'}` 这类不可达组合不再存在于输出空间。
   */
  it('should collapse nine input combinations into four reachable states', () => {
    const seen = new Set(
      (['none', 'per_turn', 'session_config'] as const).flatMap((c) =>
        (['unsupported', 'loading', 'ready'] as const).map((p) => modelAvailabilityOf(c, p)),
      ),
    );
    expect(seen.size).toBe(4);
    expect([...seen].sort()).toEqual([...ALL_STATES].sort());
  });
});

describe('showsModelPicker', () => {
  /** 只有 `no-config` 隐藏 —— 其余不可写时禁用（用户要知道装了哪些模型）。 */
  it('should hide only the no-config state', () => {
    expect(showsModelPicker('no-config')).toBe(false);
    for (const a of ALL_STATES.filter((x) => x !== 'no-config')) {
      expect(showsModelPicker(a)).toBe(true);
    }
  });
});

describe('writabilityOf', () => {
  /**
   * 可写性三态 —— 「不可写」的两种成因措辞不同（等一下就好 vs 一直如此）。
   *
   * 变异验证：把 `pending` 改成 `'read-only'` → 本用例变红。
   */
  it('should distinguish temporary from permanent unavailability', () => {
    expect(writabilityOf('ready')).toBe('writable');
    expect(writabilityOf('per-turn')).toBe('writable');
    expect(writabilityOf('pending')).toBe('loading');
    expect(writabilityOf('no-config')).toBe('read-only');
  });
});

describe('modelWriteOf — 类型层的可写性证明', () => {
  it('should write a ready state through the config value', () => {
    expect(modelWriteOf('ready', model('deepseek-flash'))).toEqual({
      kind: 'config_value',
      value: 'deepseek-flash',
    });
  });

  it('should write a per_turn state through the turn parameter', () => {
    expect(modelWriteOf('per-turn', model('anthropic/claude-sonnet'))).toEqual({
      kind: 'turn_param',
      id: 'anthropic/claude-sonnet',
    });
  });

  /**
   * 不可写时返回 `null` —— **不是**某个 `read_only` 变体。
   *
   * `pending` 也写不了：此刻没有配置项可改，而目录 id 的形状
   *（`provider/model`）喂给 `set_config_option` 会被 agent 拒绝。
   */
  it.each(['no-config', 'pending'] as const)('should return null for %s', (a) => {
    expect(modelWriteOf(a, model('x'))).toBeNull();
  });

  /**
   * **两个判据必须同源**：可写 ⟺ 能拿到写回目标。
   *
   * 这是防止「渲染层说能点、写入层拿不到目标」的关键不变量。
   * 变异验证：让任一分支偏离 → 本用例变红。
   */
  it('should agree with writabilityOf for every state', () => {
    for (const a of ALL_STATES) {
      const writable = writabilityOf(a) === 'writable';
      expect(modelWriteOf(a, model('x')) !== null).toBe(writable);
    }
  });
});

describe('modelKeyOf', () => {
  /** Pi 的 224 条模型只有 194 个唯一 id，靠 group 区分。 */
  it('should disambiguate models sharing an id', () => {
    expect(modelKeyOf(model('deepseek-v4-pro', 'deepseek'))).not.toBe(
      modelKeyOf(model('deepseek-v4-pro', 'opencode')),
    );
    expect(modelKeyOf(model('deepseek-v4-pro', 'deepseek'))).toBe('deepseek-v4-pro|deepseek');
  });

  /** 无 group 时是裸 id —— **不带尾部 `|`**，否则两种表示会分叉。 */
  it('should fall back to the bare id without a group', () => {
    expect(modelKeyOf(model('solo'))).toBe('solo');
  });
});

/**
 * `resolveModelById` —— 裸 id 的歧义消解。
 *
 * # 为什么需要专门一个入口
 *
 * 模型身份是 `(id, group)`，但会话只能回推**裸 id**（`configOptions.currentValue`
 * 与历史记录都是单个字符串，`group` 不参与）。所以「会话说它在用
 * `deepseek-v4-pro`」面对 4 条同名条目时，直接 `find` 的结果取决于数组顺序。
 */
describe('resolveModelById — 裸 id 歧义消解', () => {
  const dupes = [
    model('deepseek-v4-pro', 'deepseek'),
    model('deepseek-v4-pro', 'opencode'),
    model('deepseek-v4-pro', 'ark-coding-plan'),
    model('solo'),
  ];

  it('should return the single match when the id is unique', () => {
    expect(resolveModelById(dupes, 'solo')?.group).toBeUndefined();
  });

  it('should return undefined for an unknown id', () => {
    expect(resolveModelById(dupes, 'nope')).toBeUndefined();
  });

  /**
   * **多条同名时必须保留当前条目，不得按数组顺序跳行。**
   *
   * 这是本函数的全部价值。用户选了 `opencode` 那条，会话回推同一个裸 id，
   * 若按顺序命中 `deepseek` 那条 → 高亮跳到另一行（而实际在跑的没变）。
   *
   * 变异验证：删掉 `current` 分支（直接 `return matches[0]`）→ 本用例变红。
   */
  it('should keep the current entry when several models share the id', () => {
    const current = model('deepseek-v4-pro', 'opencode');
    expect(resolveModelById(dupes, 'deepseek-v4-pro', current)?.group).toBe('opencode');
  });

  /** 当前条目不在同名组里（如刚切过 agent）→ 回落第一条。 */
  it('should fall back to the first match when current is not among them', () => {
    const current = model('deepseek-v4-pro', 'gone');
    expect(resolveModelById(dupes, 'deepseek-v4-pro', current)?.group).toBe('deepseek');
  });

  it('should fall back to the first match when there is no current', () => {
    expect(resolveModelById(dupes, 'deepseek-v4-pro')?.group).toBe('deepseek');
  });

  /** `hasModelId` 只问「这个裸 id 还在不在」，同名多条也算存在。 */
  it('should detect an id regardless of how many entries share it', () => {
    expect(hasModelId(dupes, 'deepseek-v4-pro')).toBe(true);
    expect(hasModelId(dupes, 'solo')).toBe(true);
    expect(hasModelId(dupes, 'nope')).toBe(false);
  });
});

// ─── 配置类控件的可见性判据（2026-10-23）────────────────────────────────
//
// 历史上 `ChatComposer` 用 `sessionConfigView === 'ready'` 门控模式/档位，
// 因为当时只有 `SessionConfig` 传输会产出 configOptions。
//
// serve 打破了这个前提：它的 **模型** 是 per-turn（`ConfigCapability::PerTurn`），
// 但它**确实**产出 configOptions（模式 / 思考等级）。于是：
//
//   modelAvailabilityOf('per_turn', 'ready') === 'per-turn'
//   → `=== 'ready'` 为 false → 模式/档位永不渲染      ← 真实故障
//
// 正确的判据是「**有没有配置项可写**」，与「模型怎么传」解耦：
// 配置项的存在性由 `sessionConfigOptions.length` 回答，
// 会话是否就绪由 `availability !== 'pending'` 回答。

describe('showsConfigControls', () => {
  /** 有配置项 + 会话就绪 → 渲染（与模型是 per-turn 还是 session_config 无关）。 */
  it('should show config controls whenever options exist and the session is ready', () => {
    // serve：PerTurn 但产出了 options
    expect(showsConfigControls('per-turn', 2)).toBe(true);
    // ACP：SessionConfig 且有 options
    expect(showsConfigControls('ready', 2)).toBe(true);
  });

  /**
   * **这条是真实故障的回归**：`per-turn` 曾被当成「没有配置项」。
   *
   * 变异验证：把判据改回 `availability === 'ready'` → 本用例红。
   */
  it('should not gate on the model transport kind', () => {
    expect(showsConfigControls('per-turn', 1)).toBe(true);
  });

  /** 没有配置项 → 不渲染（显示一个点不动的下拉比不显示更糟）。 */
  it('should hide config controls when the agent provides none', () => {
    expect(showsConfigControls('ready', 0)).toBe(false);
    expect(showsConfigControls('per-turn', 0)).toBe(false);
  });

  /** 会话未就绪 → 不渲染（那时的 options 是上一会话的残留）。 */
  it('should hide config controls before the session is ready', () => {
    expect(showsConfigControls('pending', 5)).toBe(false);
  });

  /** 无配置通道的传输 → 不渲染。 */
  it('should hide config controls when the transport has no config channel', () => {
    expect(showsConfigControls('no-config', 5)).toBe(false);
  });
});
