import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  TRANSPORTS,
  TRANSPORT_LABELS,
  transportOf,
  type ChatLaunch,
  type ChatTransport,
} from '@/shared/types/agent';

/**
 * 跨栈护栏：前端的传输表必须与后端**同一个**标识符序列。
 *
 * # 为什么断言 `id` 序列而不是逐 token 比对
 *
 * 旧护栏把后端的 token 字面量逐个 `expect(rust).toContain('"acp"')`，那是
 * 用测试替类型系统干活：只证明「字符串出现过」，证明不了「两端判据一致」。
 * `id` 序列同时钉住**集合**与**优先级**（表的顺序即优先级），而具体 token
 * 规则只归后端所有 —— 前端不重复一份。
 */
function backendTransportIds(): string[] {
  const rust = readFileSync(
    resolve(__dirname, '../../../../src-tauri/src/common/agent/chat_launch.rs'),
    'utf8',
  );
  // 只取规则表那一段，避免命中 `as_str` 之外的字符串。
  const table = rust.split('pub static TRANSPORT_RULES')[1]?.split('];')[0] ?? '';
  return [...table.matchAll(/rule\(ChatTransport::\w+,\s*"([a-z-]+)"/g)].map((m) => m[1]);
}

describe('TRANSPORTS mirrors the backend rule table', () => {
  it('has the same ids in the same order (order encodes priority)', () => {
    const backend = backendTransportIds();
    expect(backend.length).toBeGreaterThanOrEqual(4);
    expect(TRANSPORTS.map((d) => d.id)).toEqual(backend);
  });

  it('has no duplicate ids', () => {
    const ids = TRANSPORTS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('labels every transport', () => {
    for (const def of TRANSPORTS) {
      expect(TRANSPORT_LABELS[def.id]).toBe(def.label);
      expect(def.label.length).toBeGreaterThan(0);
    }
  });
});

describe('transportOf', () => {
  const launch = (program: string | null, args: string[]): ChatLaunch => ({
    program,
    args,
  });

  it.each<[string, ChatLaunch, ChatTransport]>([
    ['acp subcommand', launch('opencode', ['acp']), 'acp'],
    ['serve subcommand', launch('opencode', ['serve']), 'serve'],
    ['--jsonl', launch(null, ['--jsonl']), 'jsonl'],
    ['stream-json', launch(null, ['stream-json']), 'jsonl'],
    ['--mode rpc pair', launch(null, ['--mode', 'rpc']), 'pi-rpc'],
    ['bare rpc', launch(null, ['rpc']), 'pi-rpc'],
  ])('recognises %s', (_name, chat, want) => {
    expect(transportOf(chat)).toBe(want);
  });

  it('prefers acp over serve (they are mutually exclusive subcommands)', () => {
    // 表顺序即优先级：交换两项会让 opencode serve acp 静默走错传输。
    expect(transportOf(launch('opencode', ['serve', 'acp']))).toBe('acp');
  });

  it('does not match substrings', () => {
    // `--preserve` / `--observe` 含 "serve"，子串匹配会误判成 Serve。
    expect(transportOf(launch('foo', ['--preserve']))).toBe('acp');
    expect(transportOf(launch('foo', ['--observe']))).toBe('acp');
  });

  it('requires the complete --mode rpc pair', () => {
    expect(transportOf(launch('pi', ['--mode', 'json']))).toBe('acp');
  });

  it('defaults to acp and returns null for no chat', () => {
    expect(transportOf(launch('opencode', []))).toBe('acp');
    expect(transportOf(null)).toBeNull();
    expect(transportOf(undefined)).toBeNull();
  });
});
