import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '@/shared/types';

import AgentForm from '../AgentForm';

/**
 * 内置 agent 的 CHAT 区：**只读出厂协议 + 一个开关**。
 *
 * # 为什么出厂协议不可编辑
 *
 * `chat` 是出厂事实（协议 + 参数）。用户换协议的诉求走「新建自定义 agent」——
 * 那本来就是他真正在做的事。让内置定义可改会让出厂修正永远追不上旧快照
 *（spec §10.5d 事故形态）。
 *
 * # 为什么必须断言「出厂 chat 原样带回」
 *
 * 表单态里的 `chatArgv` 是**投影**：`formatChatLaunch` 会把 `AgentConfig.command`
 * 填进 `program`。内置 `pi` 出厂是 `{program: None, args: ['--mode','rpc']}`
 *（「沿用 command」），若提交时用投影值，`program` 会变成 `Some('pi')`
 *（「显式 pi」）—— 语义变了，出厂升级不再跟随。这是「打开表单 → 保存」
 * 就会静默改写配置的典型形态。
 */

vi.mock('@/features/agent/api/agentApi', () => ({
  addAgent: vi.fn(),
  saveAgent: vi.fn(),
  resolveAgentIconSrc: () => null,
}));

function builtin(patch: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'opencode',
    name: 'opencode',
    command: 'opencode',
    args: [],
    env: {},
    enabled: true,
    is_builtin: true,
    chat: { program: 'opencode', args: ['serve'] },
    ...patch,
  } as AgentConfig;
}

function renderForm(initial: AgentConfig, onSaved = vi.fn()) {
  const utils = render(<AgentForm initial={initial} onSaved={onSaved} onCancel={vi.fn()} />);
  return { ...utils, onSaved };
}

async function submit() {
  fireEvent.click(screen.getByRole('button', { name: /save|update/i }));
}

describe('built-in agent CHAT section', () => {
  it('shows the factory protocol read-only instead of an argv editor', () => {
    renderForm(builtin());

    // 识别结果可见（来自 TRANSPORTS 表，不是硬编码）。
    expect(screen.getByText(/opencode serve/i)).toBeInTheDocument();
    // 没有可编辑的 argv 控件。
    expect(screen.queryByRole('group', { name: /CHAT Launch/i })).not.toBeInTheDocument();
  });

  it('offers a three-state chat enable selector', () => {
    renderForm(builtin());

    // 三态：Default（跟随出厂）/ On / Off —— 当前态直接可见，不再需要
    // 「两态 checkbox + 救急 Reset 按钮」的隐形状态。
    expect(screen.getByRole('radio', { name: 'Default' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'On' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Off' })).not.toBeChecked();
  });

  it('offers no chat inputs for a built-in agent without a chat protocol', () => {
    renderForm(builtin({ id: 'gemini', name: 'gemini', command: 'gemini', chat: null }));

    expect(screen.queryByRole('group', { name: /CHAT Launch/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'On' })).not.toBeInTheDocument();
    expect(screen.getByText(/no built-in chat protocol/i)).toBeInTheDocument();
  });

  it('keeps a full editor for custom agents', () => {
    renderForm(builtin({ id: 'mine', name: 'Mine', is_builtin: false, chat: { args: ['acp'] } }));

    expect(screen.getByRole('group', { name: /CHAT Launch/i })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'On' })).not.toBeInTheDocument();
  });

  it('shows the factory protocol label for an in-process built-in chat', () => {
    // mockAgent：出厂 chat 是 inprocess（投影 argv 为空）。协议标签必须来自
    // `initial.chat` 的直接识别 —— 走投影会误判成「无协议」。
    renderForm(
      builtin({ id: 'mockAgent', name: 'Mock Agent', command: '', chat: { inprocess: true } }),
    );

    expect(screen.getByText(/ACP · JSON-RPC stdio/i)).toBeInTheDocument();
    expect(screen.queryByText(/no built-in chat protocol/i)).not.toBeInTheDocument();
  });
});

describe('custom agent wire-format selector', () => {
  /**
   * **帧格式是配置项，不是推断结果。**
   *
   * 旧版按可执行文件名猜 NDJSON：改名 / 包一层 wrapper 就静默换错协议，且
   * 用户无法覆盖。选择器是那条推断的正式替代品 —— 显式选择（含
   * content-length）落盘后，后端装载期迁移短路。
   *
   * 变异验证：`buildChatLaunch` 丢弃 wireFormat → 前两条红（落库丢字段）。
   */
  it('exposes the selector for ACP custom agents and persists the choice', async () => {
    const { onSaved } = renderForm(
      builtin({ id: 'mine', name: 'Mine', is_builtin: false, chat: { args: ['acp'] } }),
    );

    const select = screen.getByLabelText(/wire format/i);
    expect(select).toHaveValue('content-length');
    fireEvent.change(select, { target: { value: 'ndjson' } });
    await submit();

    const saved = onSaved.mock.calls[0]?.[0] as AgentConfig;
    expect(saved.chat?.wire_format).toBe('ndjson');
  });

  it('lets an opencode-named custom agent pin content-length explicitly', async () => {
    const { onSaved } = renderForm(
      builtin({
        id: 'mine',
        name: 'Mine',
        is_builtin: false,
        command: 'opencode',
        chat: { args: ['acp'] },
      }),
    );

    fireEvent.change(screen.getByLabelText(/wire format/i), {
      target: { value: 'content-length' },
    });
    await submit();

    const saved = onSaved.mock.calls[0]?.[0] as AgentConfig;
    expect(saved.chat?.wire_format).toBe('content-length');
  });

  it('hides the selector for non-ACP transports and in-process chats', () => {
    const { rerender } = renderForm(
      builtin({
        id: 'mine',
        name: 'Mine',
        is_builtin: false,
        chat: { program: 'opencode', args: ['serve'] },
      }),
    );
    expect(screen.queryByLabelText(/wire format/i)).not.toBeInTheDocument();

    rerender(
      <AgentForm
        initial={builtin({
          id: 'mine',
          name: 'Mine',
          is_builtin: false,
          chat: { inprocess: true },
        })}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/wire format/i)).not.toBeInTheDocument();
  });
});

describe('built-in agent submission', () => {
  it('carries the factory chat through unchanged (program stays None)', async () => {
    // 出厂 `pi`：只有 args，「沿用 command」。
    const initial = builtin({
      id: 'pi',
      name: 'pi',
      command: 'pi',
      chat: { args: ['--mode', 'rpc'] },
    });
    const { onSaved } = renderForm(initial);

    await submit();

    const saved = onSaved.mock.calls[0]?.[0] as AgentConfig;
    expect(saved.chat).toEqual(initial.chat);
    expect(saved.chat?.program ?? null).toBeNull();
  });

  it('does not turn undefined chat_enabled into true on a plain save', async () => {
    const initial = builtin(); // chat_enabled 缺省 = 跟随出厂
    const { onSaved } = renderForm(initial);

    await submit();

    const saved = onSaved.mock.calls[0]?.[0] as AgentConfig;
    expect(saved.chat_enabled ?? null).toBeNull();
  });

  it('records an explicit opt-out when Off is selected', async () => {
    const initial = builtin();
    const { onSaved } = renderForm(initial);

    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    await submit();

    const saved = onSaved.mock.calls[0]?.[0] as AgentConfig;
    expect(saved.chat_enabled).toBe(false);
    // 出厂协议不受开关影响。
    expect(saved.chat).toEqual(initial.chat);
  });

  it('records an explicit opt-in when On is selected', async () => {
    const initial = builtin({ chat_enabled: false });
    const { onSaved } = renderForm(initial);

    fireEvent.click(screen.getByRole('radio', { name: 'On' }));
    await submit();

    const saved = onSaved.mock.calls[0]?.[0] as AgentConfig;
    expect(saved.chat_enabled).toBe(true);
  });

  it('returns to follow-the-factory when Default is selected', async () => {
    // 三态的全部意义：显式 on/off 之后还能回到 null —— 出厂修正继续跟上。
    const initial = builtin({ chat_enabled: false });
    const { onSaved } = renderForm(initial);

    fireEvent.click(screen.getByRole('radio', { name: 'Default' }));
    await submit();

    const saved = onSaved.mock.calls[0]?.[0] as AgentConfig;
    expect(saved.chat_enabled ?? null).toBeNull();
  });

  it('writes no chat_enabled preference for a built-in agent without a factory chat', async () => {
    // 出厂没有 chat 的内置 agent 没有可开关的东西 —— 提交偏好是纯噪音（判据被
    // `chat: null` 压住，但配置里从此躺着一个改不动也看不见的字段）。
    const initial = builtin({ id: 'gemini', name: 'gemini', command: 'gemini', chat: null });
    const { onSaved } = renderForm(initial);

    await submit();

    const saved = onSaved.mock.calls[0]?.[0] as AgentConfig;
    expect(saved.chat ?? null).toBeNull();
    expect(saved.chat_enabled ?? null).toBeNull();
  });

  it('preserves every other overridable field across a plain save', async () => {
    const initial = builtin({
      command: 'oc',
      args: ['--mine'],
      prompt_args: ['-p'],
      post_prompt_args: ['--json'],
      model_list_args: ['models'],
      skill_path: '/skills',
      deploy: { skills: '{{projectPath}}/s', commands: null, mcp_config: null },
    });
    const { onSaved } = renderForm(initial);

    await submit();

    const saved = onSaved.mock.calls[0]?.[0] as AgentConfig;
    expect(saved.command).toBe('oc');
    expect(saved.args).toEqual(['--mine']);
    expect(saved.prompt_args).toEqual(['-p']);
    expect(saved.post_prompt_args).toEqual(['--json']);
    expect(saved.model_list_args).toEqual(['models']);
    expect(saved.skill_path).toBe('/skills');
    expect(saved.deploy).toEqual(initial.deploy);
  });
});
