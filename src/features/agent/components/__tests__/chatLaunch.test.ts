import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ChatLaunch } from '@/shared/types/agent';
import { transportOf } from '@/shared/types/agent';

import {
  TRANSPORT_LABELS,
  buildChatLaunch,
  chatTransportLabel,
  formatChatLaunch,
  formatEnvText,
  parseEnvText,
} from '../agentFormChat';

/**
 * CHAT 启动配置的读写与传输识别。
 *
 * 设计变化的背景：传输**不再**是用户可选项（历史上有个
 * `acp/serve/jsonl/mock/pi-rpc` 下拉）。它是从启动命令识别出来的派生物。
 *
 * 第二个设计变化（本次）：表单态直接持有 **argv 数组**，不再压成一行文本。
 * 那条投影不幂等 —— `['--sys','hello world']` 会变成 `['--sys','hello','world']`，
 * 于是「打开设置页 → 保存」静默改写用户配置。
 */

describe('transportOf', () => {
  const launch = (program?: string, args: string[] = []): ChatLaunch => ({ program, args });

  it('defaults to acp for an empty launch', () => {
    expect(transportOf({})).toBe('acp');
  });

  it('recognises each transport', () => {
    expect(transportOf(launch('opencode', ['acp']))).toBe('acp');
    expect(transportOf(launch('opencode', ['serve']))).toBe('serve');
    expect(transportOf(launch(undefined, ['--jsonl']))).toBe('jsonl');
    expect(transportOf(launch(undefined, ['stream-json']))).toBe('jsonl');
    expect(transportOf(launch(undefined, ['--mode', 'rpc']))).toBe('pi-rpc');
    expect(transportOf(launch(undefined, ['rpc']))).toBe('pi-rpc');
  });

  it('acp wins over serve (mutually exclusive subcommands)', () => {
    expect(transportOf(launch('opencode', ['serve', 'acp']))).toBe('acp');
  });

  /** 子串匹配反例：`--observe` 含 "serve"，`--preserve` 也含。 */
  it('does not match substrings', () => {
    expect(transportOf(launch('foo', ['--preserve']))).toBe('acp');
    expect(transportOf(launch('foo', ['--observe']))).toBe('acp');
  });

  it('mode json is not pi rpc', () => {
    expect(transportOf(launch('pi', ['--mode', 'json']))).toBe('acp');
  });

  it('returns null when there is no chat capability', () => {
    expect(transportOf(null)).toBeNull();
    expect(transportOf(undefined)).toBeNull();
  });

  /**
   * **跨栈护栏**：前端的 token 判定必须与后端 `ChatLaunch::transport()` 同规则。
   *
   * 读 Rust 源码而不是调用（前端测试跑不起来 Rust）。任一端的 token 集合或
   * 优先级漂移都会在这里暴露 —— 否则用户配了 `serve` 却被后端当 ACP spawn，
   * 没有任何运行时错误。
   */
  it('agrees with the backend recogniser on every token', () => {
    const rust = readFileSync(
      resolve(__dirname, '../../../../../src-tauri/src/common/agent/chat_launch.rs'),
      'utf8',
    );

    // 后端也必须只认完整 token（`tokens.contains`），不能子串匹配。
    expect(rust).toContain('tokens.contains(&wanted)');
    expect(rust).not.toContain('t.contains(wanted)');

    // 每个分派字面量都要在两端存在。
    expect(
      ['acp', 'serve', '--jsonl', 'stream-json', '--mode', 'rpc'].filter(
        (t) => !rust.includes(`"${t}"`),
      ),
    ).toEqual([]);

    // 优先级：acp 的判定必须出现在 serve 之前。
    const acpAt = rust.indexOf('has("acp")');
    const serveAt = rust.indexOf('has("serve")');
    expect(acpAt).toBeGreaterThan(-1);
    expect(serveAt).toBeGreaterThan(-1);
    expect(acpAt).toBeLessThan(serveAt);
  });
});

describe('buildChatLaunch / formatChatLaunch', () => {
  it('returns null for an empty argv', () => {
    expect(buildChatLaunch([], '')).toBeNull();
  });

  it('splits argv into program + args', () => {
    expect(buildChatLaunch(['opencode', 'acp'], '')).toEqual({
      program: 'opencode',
      args: ['acp'],
    });
  });

  it('accepts a program with no args', () => {
    expect(buildChatLaunch(['gemini'], '')).toEqual({ program: 'gemini', args: [] });
  });

  it('attaches env when present', () => {
    const got = buildChatLaunch(['pi', '--mode', 'rpc'], 'DEBUG=1');
    expect(got?.env).toEqual({ DEBUG: '1' });
  });

  it('omits env when empty (no empty-object noise in config.json)', () => {
    const got = buildChatLaunch(['opencode', 'acp'], '   ');
    expect(got).not.toHaveProperty('env');
  });

  it('round-trips through the argv form', () => {
    const launch: ChatLaunch = { program: 'opencode', args: ['serve'] };
    const argv = formatChatLaunch(launch, 'fallback');
    expect(buildChatLaunch(argv, '')).toEqual(launch);
  });

  it('falls back to the CLI command when program is absent', () => {
    expect(formatChatLaunch({ args: ['--mode', 'rpc'] }, 'pi')).toEqual(['pi', '--mode', 'rpc']);
  });

  it('returns an empty argv when there is no chat capability', () => {
    expect(formatChatLaunch(null, 'pi')).toEqual([]);
  });

  /**
   * **进程内实现的往返**：`mockAgent` 的合法形态是「无 argv + 有 CHAT 能力」，
   * 而「空 argv」表示无 CHAT 能力 —— 两者必须能区分并各自往返。
   *
   * 变异验证：`buildChatLaunch` 忽略 inprocess 参数 → 第一个断言变红（能力丢失）。
   */
  it('round-trips an in-process launch without inventing a command line', () => {
    const launch: ChatLaunch = { inprocess: true };
    expect(formatChatLaunch(launch, 'mockAgent')).toEqual([]);
    expect(buildChatLaunch([], '', true)).toEqual(launch);
  });

  it('keeps env on an in-process launch', () => {
    expect(buildChatLaunch([], 'DEBUG=1', true)).toEqual({
      inprocess: true,
      env: { DEBUG: '1' },
    });
  });

  it('still treats an empty argv as no CHAT capability', () => {
    expect(buildChatLaunch([], '', false)).toBeNull();
  });

  /**
   * **方案 C 的存在理由**：含空格的参数必须无损往返。
   *
   * 旧的「一行文本」投影在这里失真（`--sys "hello world"` 会被切成三个 token），
   * 且因为「打开→保存」不幂等而静默改写用户配置。
   */
  it('preserves an argument that contains spaces', () => {
    const launch: ChatLaunch = { program: 'x', args: ['--sys', 'hello world'] };
    const argv = formatChatLaunch(launch, 'x');
    expect(argv).toEqual(['x', '--sys', 'hello world']);
    expect(buildChatLaunch(argv, '')).toEqual(launch);
  });

  /** 空串参数是合法 argv（`git commit -m ""`），不得被归一掉。 */
  it('preserves an empty-string argument', () => {
    const launch: ChatLaunch = { program: 'x', args: ['-m', ''] };
    expect(buildChatLaunch(formatChatLaunch(launch, 'x'), '')).toEqual(launch);
  });
});

describe('parseEnvText', () => {
  it('parses simple pairs', () => {
    expect(parseEnvText('KEY=v')).toEqual({ KEY: 'v' });
  });

  /** 只按第一个 `=` 切分 —— 值里的 `=` 必须保留（URL 查询串很常见）。 */
  it('splits on the first equals only', () => {
    expect(parseEnvText('URL=http://x?a=b')).toEqual({ URL: 'http://x?a=b' });
  });

  it('accepts an empty value', () => {
    expect(parseEnvText('KEY=')).toEqual({ KEY: '' });
  });

  it('trims key and value', () => {
    expect(parseEnvText('  KEY  =  v  ')).toEqual({ KEY: 'v' });
  });

  it('ignores blank lines and full-line comments', () => {
    expect(parseEnvText('\n# a comment\nKEY=v\n\n')).toEqual({ KEY: 'v' });
  });

  /** `#` 只在行首才是注释 —— 值里的 `#` 是数据。 */
  it('keeps a hash inside the value', () => {
    expect(parseEnvText('KEY=#v')).toEqual({ KEY: '#v' });
  });

  it('ignores lines without a key', () => {
    expect(parseEnvText('=v\nKEY=1')).toEqual({ KEY: '1' });
    expect(parseEnvText('NOEQUALS')).toEqual({});
  });

  it('last duplicate wins (shell semantics)', () => {
    expect(parseEnvText('K=1\nK=2')).toEqual({ K: '2' });
  });

  it('formats back with stable key order', () => {
    expect(formatEnvText({ B: '2', A: '1' })).toBe('A=1\nB=2');
    expect(formatEnvText(undefined)).toBe('');
  });

  it('round-trips through the text form', () => {
    const env = { ZED: 'last', ALPHA: 'first' };
    expect(parseEnvText(formatEnvText(env))).toEqual(env);
  });
});

describe('chatTransportLabel', () => {
  it('shows the recognised transport', () => {
    expect(chatTransportLabel(['opencode', 'serve'])).toBe(TRANSPORT_LABELS['serve']);
  });

  it('returns null for an empty argv', () => {
    expect(chatTransportLabel([])).toBeNull();
  });

  it('reports a label for an in-process launch', () => {
    expect(chatTransportLabel([], true)).toBe(TRANSPORT_LABELS['acp']);
  });

  it('has a label for every transport', () => {
    for (const t of ['acp', 'serve', 'jsonl', 'pi-rpc'] as const) {
      expect(TRANSPORT_LABELS[t]).toBeTruthy();
    }
  });
});

/**
 * 传输下拉必须**彻底**消失。
 *
 * 这不是「UI 少一个控件」的审美问题：那个下拉让用户为每个 agent 声明一个
 * 既成事实（opencode 只会 serve，pi 只会自己那套 rpc），选错只会得到跑不
 * 起来的配置，且表单给不出任何提示。
 */
describe('no transport picker remains', () => {
  it('agentFormChat exports no option list', () => {
    const src = readFileSync(resolve(__dirname, '../agentFormChat.ts'), 'utf8');
    // 断言形式而非 throw：`vitest/expect-expect` 要求每个 it 至少一个 expect。
    expect(['CHAT_OPTIONS', 'CHAT_HINTS', 'buildChatStart'].filter((s) => src.includes(s))).toEqual(
      [],
    );
  });

  it('AgentForm renders no select for chat transport', () => {
    const src = readFileSync(resolve(__dirname, '../AgentForm.tsx'), 'utf8');
    expect(src).not.toContain('CHAT Transport');
    // 传输没有下拉。其它 `<select>`（如 Detection 的 kind）是合法的 ——
    // 断言的是「CHAT 区不存在传输选择器」，不是「全文件没有 select」。
    expect(src).not.toContain('chatTransportOptions');
    expect(src).not.toContain('CHAT_OPTIONS');
    // 启动命令与环境变量各一个控件区。
    expect(src).toContain('CHAT Launch');
    expect(src).toContain('CHAT Env');
  });

  /** 旧的 chat_command / chat_args 双输入组件已合并进命令行，不得复活。 */
  it('ChatLaunchFields is deleted', () => {
    expect(() => readFileSync(resolve(__dirname, '../ChatLaunchFields.tsx'), 'utf8')).toThrow();
  });

  it('the form state carries argv arrays plus one env block', () => {
    const src = readFileSync(resolve(__dirname, '../agentFormState.ts'), 'utf8');
    expect(src).toContain('chatArgv: string[];');
    expect(src).toContain('chatEnvText: string;');
    expect(
      ['acpArgsText', 'chatArgsText', 'chatCommandLine:', 'argsText'].filter((s) =>
        src.includes(s),
      ),
    ).toEqual([]);
  });
});

/**
 * **投影缺陷不得回潮**：argv 一旦被压回「一行文本 + 空格切分」，
 * 「打开设置页 → 保存」就会再次静默改写用户配置。
 *
 * 判据是源码里不存在 separator 式的切分/拼接辅助。
 */
describe('argv is never projected back to a single line', () => {
  it('no whitespace-splitting helper is used for args', () => {
    const files = ['AgentForm.tsx', 'agentFormChat.ts', 'agentFormState.ts', 'argList.ts'];
    // 用 RegExp 构造避开字面量分隔符与闭合 `/` 的转义冲突。
    const splitOnSpace = new RegExp(String.raw`split\(\/\\s`);
    const joinOnSpace = new RegExp(String.raw`\.join\(' '\)`);
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(resolve(__dirname, `../${file}`), 'utf8');
      if (splitOnSpace.test(src) || joinOnSpace.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('the ArgListEditor is the shared control for every argv field', () => {
    const src = readFileSync(resolve(__dirname, '../AgentForm.tsx'), 'utf8');
    // 五个 argv 字段（args / chatArgv / 三件套）全部走同一个控件。
    expect(src.match(/<ArgListEditor/g)?.length).toBe(5);
  });
});
