// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildAgentConfig, emptyFormState } from '../agentFormState';

describe('buildAgentConfig 幽灵字符剥离（WKWebView 守卫的保存层兜底）', () => {
  it('skill_path 两侧的方向键遗留字符在提交边界剥离', () => {
    const t = emptyFormState();
    t.skillPath = '\uF702~/.dsh/skills\uF703\uF703\uF703';

    const cfg = buildAgentConfig(t, null, null);

    expect(cfg.skill_path).toBe('~/.dsh/skills');
  });

  it('command / args / detection / deploy 同样剥离', () => {
    const t = emptyFormState();
    t.command = 'dsh\uF703';
    t.args = ['run\uF702', '\uF703', ''];
    t.detectionTarget = '~/.dsh/skills\uF702';
    t.deployCommands = 'ln -s\uF703';

    const cfg = buildAgentConfig(t, null, null);

    expect(cfg.command).toBe('dsh');
    expect(cfg.args).toEqual(['run']);
    expect(cfg.detection).toEqual({ type: 'command', target: '~/.dsh/skills' });
    expect(cfg.deploy?.commands).toBe('ln -s');
  });

  it('正常文本原样提交', () => {
    const t = emptyFormState();
    t.command = 'dsh';
    t.skillPath = '~/.dsh/skills';
    t.args = ['--config', 'a b'];

    const cfg = buildAgentConfig(t, null, null);

    expect(cfg.command).toBe('dsh');
    expect(cfg.skill_path).toBe('~/.dsh/skills');
    expect(cfg.args).toEqual(['--config', 'a b']);
  });
});
