import { describe, expect, it } from 'vitest';

import type { ToolCard } from '../../types';
import { recordToolStart, type TurnCounts } from '../toolTurnOps';

function counts(): TurnCounts {
  return { ran: 0, edited: 0, searched: 0 };
}

/** 计数归类通过 `recordToolStart` 的可观测行为验证（内部实现不导出）。 */
function bucketFor(name: string): 'ran' | 'edited' | 'searched' {
  const c = counts();
  recordToolStart(name, 'c', 't', [], c);
  if (c.searched > 0) return 'searched';
  if (c.edited > 0) return 'edited';
  return 'ran';
}

describe('recordToolStart — 计数归类', () => {
  /** 读类工具归 `searched`。 */
  it.each(['read_file', 'search', 'grep'])('should bucket %s as searched', (name) => {
    expect(bucketFor(name)).toBe('searched');
  });

  /** 写类工具归 `edited`。 */
  it.each(['edit_file', 'write_file'])('should bucket %s as edited', (name) => {
    expect(bucketFor(name)).toBe('edited');
  });

  /** 其余（bash 等）归 `ran`。 */
  it.each(['bash', 'unknown_tool'])('should bucket %s as ran', (name) => {
    expect(bucketFor(name)).toBe('ran');
  });

  /**
   * **必须按归一化名归类**。
   *
   * `edit` / `exec_command` 是 opencode 的原始名。不归一化会让 live 流与
   * 历史恢复（historyConvert）算出不同的话轮摘要。
   *
   * 变异验证：把 `normalizeToolName` 去掉 → 本用例变红。
   */
  it('should bucket raw framework names by their normalized form', () => {
    // opencode 的 `edit` → `edit_file`（edited），不是 ran
    expect(bucketFor('edit')).toBe('edited');
  });
});

describe('recordToolStart', () => {
  it('should create a running tool and bump the matching bucket', () => {
    const c = counts();
    const tool = recordToolStart('read_file', 'c1', 'read a', [], c);
    expect(tool).toEqual({ callId: 'c1', name: 'read_file', title: 'read a', status: 'running' });
    expect(c.searched).toBe(1);
    expect(c.ran).toBe(0);
  });

  /**
   * 重复 `callId` 必须丢弃且**不计数**。
   *
   * 真实场景：opencode serve 对同一工具先发 `pending` 再发 `running`。
   * 变异验证：去掉去重 → 本用例变红（计数翻倍）。
   */
  it('should drop a duplicate call id without counting it twice', () => {
    const c = counts();
    const seen: ToolCard[] = [];
    const first = recordToolStart('bash', 'c1', 'run', seen, c);
    expect(first).not.toBeNull();
    seen.push(first as ToolCard);

    const second = recordToolStart('bash', 'c1', 'run', seen, c);
    expect(second).toBeNull();
    expect(c.ran).toBe(1);
  });
});
