// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { PersistentCacheEntry, PersistentCachePort } from '../persistentKeyValueStore';
import { PersistentKeyValueStore } from '../persistentKeyValueStore';

/**
 * 通用持久化 KV 缓存。
 *
 * 这套能力从 `features/editor/comment/translationCache.ts` 的 `PersistentCache` 上移而来，
 * 测试也随之上移并**泛型化** —— 用假的业务类型证明它不认识任何业务概念。
 */

interface Item extends PersistentCacheEntry {
  source: string;
  text: string;
}

/** 最小合法条目校验（模拟消费者注入的 validate）。 */
function validateItem(raw: unknown): Item | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Partial<Item>;
  if (typeof item.source !== 'string' || typeof item.text !== 'string') return null;
  if (typeof item.at !== 'number') return null;
  return { source: item.source, text: item.text, at: item.at };
}

/**
 * 内存 port（条目粒度）：记录写次数，可注入初始快照与失败。
 *
 * 与生产实现的关键差异：这里存 `Record`，生产 SQLite 存表行 —— 但两者对调用方
 * 是同一个 `PersistentCachePort`，这就是 Port 的价值。
 */
function makePort(initial: string | null = null, failOn = new Set<'load' | 'put'>()) {
  let store: Record<string, unknown> = initial
    ? (JSON.parse(initial) as { entries: Record<string, unknown> }).entries
    : {};
  let version = initial ? (JSON.parse(initial) as { version: number }).version : 1;

  const port = {
    load: vi.fn(async () => {
      if (failOn.has('load')) throw new Error('load failed');
      return { version, entries: { ...store } };
    }),
    putMany: vi.fn(async (entries: ReadonlyArray<readonly [string, unknown]>) => {
      if (failOn.has('put')) throw new Error('put failed');
      for (const [k, v] of entries) store[k] = v;
    }),
    deleteMany: vi.fn(async (keys: readonly string[]) => {
      for (const k of keys) delete store[k];
    }),
    /** 直接改写快照内容（模拟外部写坏的缓存文件）。 */
    setRaw(next: string) {
      const parsed = JSON.parse(next) as { version: number; entries: Record<string, unknown> };
      store = parsed.entries;
      version = parsed.version;
    },
    /** 当前快照（测试断言落盘内容用）。 */
    snapshot() {
      return { version, entries: { ...store } };
    },
  };
  return port;
}

function makeStore(port: PersistentCachePort, extra: Record<string, unknown> = {}) {
  return new PersistentKeyValueStore<Item>({
    port,
    version: 1,
    validate: validateItem,
    ...extra,
  });
}

const ITEM = (text: string, at = 1): Item => ({ source: 'src', text, at });

describe('PersistentKeyValueStore', () => {
  it('should return null for a miss', async () => {
    const store = makeStore(makePort());
    expect(await store.get('nope')).toBeNull();
  });

  it('should round-trip a value through the port after flush', async () => {
    const port = makePort();
    const store = makeStore(port);
    await store.set('k', ITEM('译文'));
    await store.flush(); // 必须显式 flush —— set 只置脏（见「dirty until flush」用例）

    // 新实例读同一 port —— 模拟进程重启
    expect((await makeStore(port).get('k'))?.text).toBe('译文');
  });

  it('should NOT write on set (dirty until flush)', async () => {
    const port = makePort();
    const store = makeStore(port);
    await store.set('a', ITEM('x'));
    await store.set('b', ITEM('y'));

    expect(port.putMany).not.toHaveBeenCalled();
    await store.flush();
    expect(port.putMany).toHaveBeenCalledTimes(1);
  });

  it('should flush once for a batch (setMany)', async () => {
    const port = makePort();
    await makeStore(port).setMany([
      ['a', ITEM('1')],
      ['b', ITEM('2')],
    ]);
    expect(port.putMany).toHaveBeenCalledTimes(1);
  });

  it('should send only the changed entries on each flush, not the whole map', async () => {
    // 写放大回归：早期实现每次 flush 都提交「整张表」，于是每次批写都要把全部
    // 已有条目重写一遍（会话越久单次写入越大）。Port 改成条目粒度就是为了避免
    // 这件事，而 store 若仍旧发全量，这个设计就白做了。
    const port = makePort();
    const store = makeStore(port);

    await store.set('a', ITEM('1'));
    await store.flush();
    await store.set('b', ITEM('2'));
    await store.flush();

    expect(port.putMany).toHaveBeenNthCalledWith(1, [['a', ITEM('1')]]);
    expect(port.putMany).toHaveBeenNthCalledWith(2, [['b', ITEM('2')]]);
  });

  it('should not write when flush is called with no dirty state', async () => {
    const port = makePort();
    await makeStore(port).flush();
    expect(port.putMany).not.toHaveBeenCalled();
  });

  it('should degrade to empty when the port returns a malformed snapshot', async () => {
    // JSON 解析现在发生在 Port 内部（条目粒度后调用方拿的是对象）。
    // 调用方仍需防「后端给了形状不对的东西」——后端的 bug 不该炸掉翻译流程。
    const port = makePort();
    port.load.mockResolvedValue({ entries: 'not-an-object' } as never);
    expect(await makeStore(port).get('k')).toBeNull();
  });

  it('should degrade to empty on version mismatch', async () => {
    const port = makePort(JSON.stringify({ version: 99, entries: { k: ITEM('old') } }));
    // Port 返回 version=99，而 store 期望 1
    port.load.mockResolvedValue({ version: 99, entries: { k: ITEM('old') } } as never);
    expect(await makeStore(port).get('k')).toBeNull();
  });

  it('should degrade to empty on read failure without throwing', async () => {
    const store = makeStore(makePort(null, new Set(['load'])));
    expect(await store.get('k')).toBeNull();
  });

  it('should swallow write failure (memory hits still work)', async () => {
    const port = makePort(null, new Set(['put']));
    const store = makeStore(port);
    await store.set('k', ITEM('译文'));
    await expect(store.flush()).resolves.toBeUndefined();
    // 内存命中仍然生效
    expect((await store.get('k'))?.text).toBe('译文');
  });

  it('should keep the dirty flag after a failed flush so the next flush retries', async () => {
    // 判别力关键：写失败后若把 dirty 清掉，这一批数据**永远不会再落盘**
    // （下次 flush 直接早退）。表面「配置没问题」，实际缓存永久丢一批。
    const port = makePort(null, new Set(['put']));
    const store = makeStore(port);
    await store.set('k', ITEM('译文'));

    await store.flush(); // 第一次：失败
    expect(port.putMany).toHaveBeenCalledTimes(1);

    // 恢复写入能力后再次 flush —— 必须真的重试（dirty 仍在）
    port.putMany.mockResolvedValue(undefined);
    await store.flush();
    expect(port.putMany).toHaveBeenCalledTimes(2);
  });

  it('should drop only the invalid entry, keeping the rest', async () => {
    const port = makePort(
      JSON.stringify({
        version: 1,
        entries: { good: ITEM('ok'), bad: { nope: true } },
      }),
    );
    const store = makeStore(port);
    expect((await store.get('good'))?.text).toBe('ok');
    expect(await store.get('bad')).toBeNull();
  });

  it('should swallow a validate that throws (not just returns null)', async () => {
    // 这条最容易被漏：只测「返回 null」不测「抛异常」时，一次坏数据会放大成缓存整体不可用
    const port = makePort(JSON.stringify({ version: 1, entries: { k: ITEM('ok') } }));
    const store = new PersistentKeyValueStore<Item>({
      port,
      version: 1,
      validate: () => {
        throw new Error('boom');
      },
    });
    expect(await store.get('k')).toBeNull();
  });

  it('should keep good entries when a sibling entry makes validate throw', async () => {
    // 判别力关键：必须有**好条与坏条共存**。若只有坏条，「丢该条」与「整份作废」
    // 结果相同，用例就测不出区别（首版正是如此，变异验证抓到的假绿）。
    const port = makePort(
      JSON.stringify({
        version: 1,
        entries: { good: ITEM('ok'), boom: ITEM('bad') },
      }),
    );
    const store = new PersistentKeyValueStore<Item>({
      port,
      version: 1,
      validate: (raw) => {
        const item = raw as Item;
        if (item.text === 'bad') throw new Error('boom');
        return validateItem(raw);
      },
    });
    // 坏条被丢，好条必须还在
    expect(await store.get('boom')).toBeNull();
    expect((await store.get('good'))?.text).toBe('ok');
  });

  it('should evict the oldest entries beyond maxEntries', async () => {
    const port = makePort();
    const store = makeStore(port, { maxEntries: 2 });
    await store.setMany([
      ['old', ITEM('1', 1)],
      ['mid', ITEM('2', 2)],
      ['new', ITEM('3', 3)],
    ]);

    expect(Object.keys(port.snapshot().entries).sort()).toEqual(['mid', 'new']);
  });

  it('should return multiple hits from getMany and omit misses', async () => {
    const port = makePort();
    await makeStore(port).setMany([
      ['a', ITEM('1')],
      ['b', ITEM('2')],
    ]);
    const hits = await makeStore(port).getMany(['a', 'missing', 'b']);
    expect([...hits.keys()].sort()).toEqual(['a', 'b']);
  });

  it('should be agnostic to the business type (generic, no domain knowledge)', async () => {
    // 证明通用性：换一个完全不同的业务类型，同一份实现照常工作
    interface Other extends PersistentCacheEntry {
      blob: string;
    }
    const store = new PersistentKeyValueStore<Other>({
      port: makePort(),
      version: 7,
      validate: (raw) =>
        typeof raw === 'object' && raw !== null && typeof (raw as Other).blob === 'string'
          ? (raw as Other)
          : null,
    });
    await store.set('k', { blob: 'x', at: 1 });
    expect((await store.get('k'))?.blob).toBe('x');
  });
});
