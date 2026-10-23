import { describe, expect, it } from 'vitest';

import type { AgentConfig } from '@/shared/types/agent';

import { toFormState } from '../agentFormState';

/**
 * `Detection` 的类型必须经表单往返后保持不变。
 *
 * # 原来的 bug
 *
 * 表单态只有一个 `detectionCmd` 字符串，读的时候写
 * `form.detection?.type === 'command' ? target : ''`，写的时候恒构造
 * `{ type: 'command' }`。于是加载一个用 `directory` 检测的 agent、保存一次，
 * 类型就被**静默**改成 `command` —— 界面看不出任何变化，但该 agent 的安装
 * 检测从此查错了对象。
 *
 * 这类「投影丢字段」的修法与 `type-safety.md` 的判据一致：让表单态承载
 * 完整的判别信息，不要靠默认值补。
 */

function agent(detection: AgentConfig['detection']): AgentConfig {
  return {
    id: 'x',
    name: 'X',
    command: 'x',
    args: [],
    env: {},
    enabled: true,
    detection,
  } as AgentConfig;
}

describe('Detection round-trip', () => {
  it('keeps a command detection', () => {
    const form = toFormState(agent({ type: 'command', target: 'opencode' }));

    expect(form.detectionType).toBe('command');
    expect(form.detectionTarget).toBe('opencode');
  });

  /** 这一条是原 bug 的复现：`directory` 的 target 曾被丢成空串。 */
  it('keeps a directory detection', () => {
    const form = toFormState(agent({ type: 'directory', target: '~/.agent/skills' }));

    expect(form.detectionType).toBe('directory');
    expect(form.detectionTarget).toBe('~/.agent/skills');
  });

  it('defaults to command when there is no detection', () => {
    const form = toFormState(agent(null));

    expect(form.detectionType).toBe('command');
    expect(form.detectionTarget).toBe('');
  });
});
