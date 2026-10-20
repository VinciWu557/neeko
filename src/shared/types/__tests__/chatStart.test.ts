/**
 * `ChatStart` 双形态（裸字符串 / 带 args 的对象）。
 *
 * 后端 `Serialize` 的取舍是「无参数写字符串、有参数才写对象」，前端两个读取
 * 辅助函数必须与之对称：拿不准形态时一律降级为空 args，而不是抛错或猜。
 */
import { describe, expect, it } from 'vitest';

import { chatAcpArgsOf, chatTransportOf } from '../agent';

describe('chatTransportOf', () => {
  it('should return the bare string form as-is', () => {
    expect(chatTransportOf('acp')).toBe('acp');
    expect(chatTransportOf('serve')).toBe('serve');
    expect(chatTransportOf('jsonl')).toBe('jsonl');
    expect(chatTransportOf('mock')).toBe('mock');
  });

  it('should read transport out of the object form', () => {
    expect(chatTransportOf({ transport: 'acp', args: ['--acp'] })).toBe('acp');
  });

  it('should return null when chat is absent', () => {
    expect(chatTransportOf(null)).toBeNull();
    expect(chatTransportOf(undefined)).toBeNull();
  });
});

describe('chatAcpArgsOf', () => {
  it('should return args from the object form', () => {
    expect(chatAcpArgsOf({ transport: 'acp', args: ['--acp', '--verbose'] })).toEqual([
      '--acp',
      '--verbose',
    ]);
  });

  /** 旧字符串形态没有 args —— 是「没有」，不是错误。 */
  it('should return an empty list for the bare string form', () => {
    expect(chatAcpArgsOf('acp')).toEqual([]);
  });

  it('should return an empty list for non-ACP transports', () => {
    expect(chatAcpArgsOf('serve')).toEqual([]);
    expect(chatAcpArgsOf('mock')).toEqual([]);
  });

  it('should return an empty list when chat is absent', () => {
    expect(chatAcpArgsOf(null)).toEqual([]);
    expect(chatAcpArgsOf(undefined)).toEqual([]);
  });
});
