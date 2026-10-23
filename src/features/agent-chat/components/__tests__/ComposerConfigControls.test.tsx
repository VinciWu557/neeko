import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ChatComposer from '../ChatComposer';

/**
 * **行为级回归**：`per-turn` 传输 + 有配置项 → 模式/档位必须渲染。
 *
 * # 为什么需要行为测试（而不只是源码断言）
 *
 * `sessionOptionsWiring.test.ts` 的断言形如 `expect(CHAT).toContain('showsConfigControls')`，
 * 它们只能防「整段删除」，防不住「判据被改窄」—— 2026-10-23 的真实故障正是后者：
 *
 * ```
 * // 修前：模型是 per-turn 时永远不等于 'ready'
 * const configWritable = sessionConfigView === 'ready';
 * ```
 *
 * 源码里 `configWritable`、`showsModelPicker(` 全都在，静态断言一片绿，
 * 但界面上两个控件**永不渲染**。用户的原话是「opencode 明明支持 plan/build，
 * 界面上没有」。
 *
 * 所以这条**渲染组件并断言 DOM** —— 对齐 `quality-guidelines.md` §18(c)：
 * 判据钉在「不变量」上，而不是「某个标识符出现了」。
 */

const BASE_PROPS = {
  input: '',
  streaming: false,
  canSend: false,
  onSend: () => {},
  onStop: () => {},
  onInputChange: () => {},
  onKeyDown: () => {},
  onOpenAttachDrop: () => {},
  chatAgents: [],
  selectedAgent: { id: 'opencode', name: 'OpenCode', icon: null },
  models: [],
  selectedModel: null,
  onModelChange: () => {},
  onConfigChange: () => {},
  contextWindow: null,
  tabKey: 't',
  tabId: 'tab',
  attachments: [],
  onRemoveAttachment: () => {},
};

/** serve 实际下发的形状（`category` 是唯一判据）。 */
const OPTIONS = [
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'build',
    options: [
      { value: 'build', name: 'Build' },
      { value: 'plan', name: 'Plan' },
    ],
  },
  {
    id: 'thought_level',
    name: 'Thinking level',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
    ],
  },
];

describe('ChatComposer 在 per-turn 传输下渲染配置控件', () => {
  /**
   * 核心回归：`per-turn`（serve 的模型传输方式）**不等于**「没有配置项」。
   *
   * 变异验证：把 `showsConfigControls(...)` 改回 `availability === 'ready'`
   * → 本用例红。
   */
  it('should render Mode and Thinking level when the transport is per-turn', () => {
    render(
      <ChatComposer
        {...(BASE_PROPS as never)}
        sessionConfigView="per-turn"
        sessionConfigOptions={OPTIONS as never}
      />,
    );

    // 收起态显示的是**当前值**的展示名（`Build` / `High`），不是配置项名 ——
    // `ParamSelectors` 的 `param-name` 渲染 `current.name`。
    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  /** ACP 的 `ready` 同样渲染（不能为了修 per-turn 而弄坏原路径）。 */
  it('should still render them for session_config transports', () => {
    render(
      <ChatComposer
        {...(BASE_PROPS as never)}
        sessionConfigView="ready"
        sessionConfigOptions={OPTIONS as never}
      />,
    );

    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  /**
   * 没有配置项 → 不渲染。
   *
   * 「显示一个点不动的下拉」比「不显示」更糟：前者让用户以为功能坏了。
   */
  it('should render nothing when the agent provides no options', () => {
    render(
      <ChatComposer
        {...(BASE_PROPS as never)}
        sessionConfigView="per-turn"
        sessionConfigOptions={[]}
      />,
    );

    expect(screen.queryByText('Build')).not.toBeInTheDocument();
    expect(screen.queryByText('High')).not.toBeInTheDocument();
  });

  /** 会话未就绪（`pending`）→ 不渲染：那时的 options 是上一会话的残留。 */
  it('should render nothing before the session is ready', () => {
    render(
      <ChatComposer
        {...(BASE_PROPS as never)}
        sessionConfigView="pending"
        sessionConfigOptions={OPTIONS as never}
      />,
    );

    expect(screen.queryByText('Build')).not.toBeInTheDocument();
  });
});
