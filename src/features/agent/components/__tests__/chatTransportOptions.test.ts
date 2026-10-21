import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CHAT_HINTS, CHAT_OPTIONS, buildChatStart, type ChatTransport } from '../agentFormChat';

/**
 * 传输选项的三处同步护栏。
 *
 * 一个传输要在四个地方同时存在才真的能用：① 前端 `ChatTransport` 类型
 * ② `CHAT_OPTIONS` 下拉项 ③ `CHAT_HINTS` 文案 ④ 后端 `ChatStart::as_str()`
 * + `adapter_for` 的分派分支。
 *
 * 漏掉 ④ 是**静默失败**：下拉能选、能保存，但后端把它当未知值兜底成 ACP，
 * 于是 spawn 出错误的命令行。这类失配没有任何运行时错误提示，只能静态护栏抓。
 */
describe('chat transport options', () => {
  it('every option has a hint and vice versa', () => {
    const fromOptions = CHAT_OPTIONS.map((o) => o.value).sort();
    const fromHints = Object.keys(CHAT_HINTS).sort();
    expect(fromOptions).toEqual(fromHints);
  });

  it('option values are unique', () => {
    const values = CHAT_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
  });

  /** 每个非 acp 传输都原样落成裸字符串（后端 `as_str()` 读的就是它）。 */
  it.each(CHAT_OPTIONS.map((o) => o.value))(
    'buildChatStart writes %s as a bare string',
    (transport: ChatTransport) => {
      const built = buildChatStart(transport, '', () => []);
      expect(built).toBe(transport);
    },
  );

  /**
   * 后端必须认识每个前端选项。
   *
   * 读后端源码而不是调用 —— 前端测试跑不起来 Rust。
   */
  it('backend recognises every frontend transport string', () => {
    const rust = readFileSync(
      resolve(__dirname, '../../../../../src-tauri/src/common/agent/types.rs'),
      'utf8',
    );
    expect(CHAT_OPTIONS.length).toBeGreaterThan(0);
    for (const { value } of CHAT_OPTIONS) {
      // as_str() 的匹配臂
      if (!rust.includes(`=> "${value}"`)) {
        throw new Error(`ChatStart::as_str() missing arm for "${value}"`);
      }
    }
  });

  /**
   * `pi-rpc` 的反序列化分支必须在 `_ => Self::Acp` 兜底**之前**。
   *
   * 写在兜底之后不会编译报错（有 `#[allow(unreachable_patterns)]` 时），
   * 只会让 `"pi-rpc"` 被吞成 ACP —— 于是 spawn 出 `pi --mode rpc` 之外的东西。
   */
  it('pi-rpc deserialization arm comes before the acp fallback', () => {
    const rust = readFileSync(
      resolve(__dirname, '../../../../../src-tauri/src/common/agent/types.rs'),
      'utf8',
    );
    const piArm = rust.indexOf('"pi-rpc" => Self::PiRpc');
    const fallback = rust.indexOf('_ => Self::Acp { args: Vec::new() }');
    // 两处锚点都必须存在，否则下面的比较毫无意义
    expect([piArm > -1, fallback > -1]).toEqual([true, true]);
    if (piArm >= fallback) {
      throw new Error('"pi-rpc" arm must precede the `_ => Acp` fallback');
    }
  });
});

/**
 * `chat_command` / `chat_args` 的存在性护栏。
 *
 * 上一轮把 `adapter_for` 从 `cmd_vec()` 换成 `chat_cmd_vec()`，但前端表单没有
 * 对应输入 —— 于是「chat 用 pi-acp、TUI 用 pi」这个需求无处表达。这组断言防止
 * 字段再次从任一端消失：**任何一端缺失都是静默失效**（存了不生效 / 填了存不下）。
 */
describe('chat launch overrides', () => {
  it('AgentConfig declares chat_command and chat_args', () => {
    const src = readFileSync(resolve(__dirname, '../../../../shared/types/agent.ts'), 'utf8');
    expect(src).toContain('chat_command?:');
    expect(src).toContain('chat_args?:');
  });

  it('the form state carries both fields end to end', () => {
    const src = readFileSync(resolve(__dirname, '../agentFormState.ts'), 'utf8');
    // 文本态字段
    expect(src).toContain('chatCommand: string;');
    expect(src).toContain('chatArgsText: string;');
    // 读方向
    expect(src).toContain('form.chat_command');
    expect(src).toContain('form.chat_args');
  });

  it('the backend entry point renders both inputs', () => {
    const src = readFileSync(resolve(__dirname, '../ChatLaunchFields.tsx'), 'utf8');
    expect(src).toContain('Chat Command');
    expect(src).toContain('Chat Args');
  });

  /// 后端必须真的消费这两个字段，否则前端填了也没用。
  it('the backend consumes them through chat_cmd_vec', () => {
    const rust = readFileSync(
      resolve(__dirname, '../../../../../src-tauri/src/common/agent/types.rs'),
      'utf8',
    );
    expect(rust).toContain('pub fn chat_cmd_vec');
    expect(rust).toContain('pub chat_command: Option<String>');
    expect(rust).toContain('pub chat_args: Option<Vec<String>>');
  });
});
