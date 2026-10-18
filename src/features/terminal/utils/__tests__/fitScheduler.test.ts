import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFitScheduler } from '../fitScheduler';

describe('fitScheduler', () => {
  let rafQueue: Array<() => void> = [];
  const rafStub = vi.fn((cb: () => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  const cancelStub = vi.fn((id: number) => {
    // remove by index (1-based)
    if (id > 0 && id <= rafQueue.length) rafQueue[id - 1] = () => {};
  });

  const flushRaf = () => {
    const q = [...rafQueue];
    rafQueue = [];
    rafStub.mockClear();
    cancelStub.mockClear();
    q.forEach((fn) => fn());
  };

  beforeEach(() => {
    rafQueue = [];
    rafStub.mockClear();
    cancelStub.mockClear();
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', rafStub);
    vi.stubGlobal('cancelAnimationFrame', cancelStub);
    if (typeof window !== 'undefined') {
      Object.defineProperty(window, 'requestAnimationFrame', {
        value: rafStub,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(window, 'cancelAnimationFrame', {
        value: cancelStub,
        writable: true,
        configurable: true,
      });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rafQueue = [];
  });

  function makeEntry(cols = 80, rows = 24, sessionId: string | null = 'sid') {
    let c = cols;
    let r = rows;
    return {
      entry: {
        term: {
          get cols() {
            return c;
          },
          get rows() {
            return r;
          },
        },
        fitAddon: {
          fit: vi.fn(() => {
            // simulate fit changing size to 100x30 after first call, then stable
          }),
        },
        sessionId,
      },
      setColsRows(nc: number, nr: number) {
        c = nc;
        r = nr;
      },
    };
  }

  it('快速连续 scheduleFit 仅合帧一次 RAF，trailing 兜底最终尺寸', async () => {
    const h = makeEntry(80, 24, 'sid');
    let fitCalls = 0;
    h.entry.fitAddon.fit = vi.fn(() => {
      fitCalls += 1;
      // first call changes to 100x30, later stable
      if (fitCalls === 1) h.setColsRows(100, 30);
    });
    const resize = vi.fn(() => Promise.resolve());
    const sched = createFitScheduler({
      getEntry: () => h.entry,
      resize,
    });

    // burst 10 calls
    for (let i = 0; i < 10; i++) sched.scheduleFit();

    // no fit yet before RAF
    expect(h.entry.fitAddon.fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();

    flushRaf();
    // RAF 合帧只执行一次 doFit
    expect(h.entry.fitAddon.fit).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith('sid', 100, 30);

    // trailing 在 120ms 后再触发一次，但此时收敛去重会跳过
    await vi.advanceTimersByTimeAsync(120);
    // trailing 会再次 fit，但 cols/rows 未变且已去重，不应二次 resize
    expect(h.entry.fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenCalledTimes(1);

    sched.dispose();
  });

  // 契约改写（根因不变式）：去重判据是「上次已同步给 PTY 的尺寸」，不是「fit 是否
  // 改变本地网格」。新调度器的 lastCols=-1，首次 fit 即使收敛也必须同步一次 ——
  // 这正是 tab 切回已 fit 过的终端时必须补发 resize 的那一步（旧实现在此早退 → 格式混乱）。
  it('新调度器首次 fit：即使尺寸未变也同步一次（tab 切回归径）', async () => {
    const h = makeEntry(80, 24, 'sid');
    // fit 不改变尺寸（切回已 fit 过的终端就是这种情况）
    h.entry.fitAddon.fit = vi.fn(() => {});
    const resize = vi.fn(() => Promise.resolve());
    const sched = createFitScheduler({ getEntry: () => h.entry, resize });

    sched.scheduleFit();
    flushRaf();
    await Promise.resolve();
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith('sid', 80, 24);

    // 同一调度器内再次触发：尺寸已同步过 → 去重生效，不再重发
    sched.scheduleFit();
    flushRaf();
    await Promise.resolve();
    expect(resize).toHaveBeenCalledTimes(1);

    // trailing 兜底同样不重发
    await vi.advanceTimersByTimeAsync(120);
    expect(resize).toHaveBeenCalledTimes(1);

    sched.dispose();
  });

  it('resize 失败保留 pending，下次触发重试成功', async () => {
    const h = makeEntry(80, 24, 'sid');
    h.entry.fitAddon.fit = vi.fn(() => {
      h.setColsRows(90, 26);
    });
    let attempt = 0;
    const resize = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('fail'));
      return Promise.resolve();
    });
    const sched = createFitScheduler({ getEntry: () => h.entry, resize });

    sched.scheduleFit();
    flushRaf();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(sched._getState().pendingCols).toBe(90);

    // 下一次 scheduleFit 应重试 pending（即使尺寸未再变）
    // reset fit to no-op (already 90x26 stable)
    h.entry.fitAddon.fit = vi.fn(() => {});
    sched.scheduleFit();
    flushRaf();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(resize).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenLastCalledWith('sid', 90, 26);
    // 成功后 pending 清空
    expect(sched._getState().pendingCols).toBeNull();

    sched.dispose();
  });

  it('无 sessionId 时挂起 pending，待 session 就绪后重试', async () => {
    const h = makeEntry(80, 24, null);
    h.entry.fitAddon.fit = vi.fn(() => {
      h.setColsRows(95, 28);
    });
    const resize = vi.fn(() => Promise.resolve());
    const sched = createFitScheduler({ getEntry: () => h.entry, resize });

    sched.scheduleFit();
    flushRaf();
    await Promise.resolve();
    expect(resize).not.toHaveBeenCalled();
    expect(sched._getState().pendingCols).toBe(95);

    // session 就绪
    (h.entry as unknown as { sessionId: string | null }).sessionId = 'sid';
    // 再次触发（session-ready 源）：fit 此时已收敛，但有 pending 失败待重试。
    // 判据要求：pending 非空时必须重发（不能因尺寸未变而跳过）。
    h.entry.fitAddon.fit = vi.fn(() => {});
    sched.scheduleFit();
    flushRaf();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    // 推进 trailing 兑底（可能多一次调度）
    await vi.advanceTimersByTimeAsync(120);
    await Promise.resolve();
    // 失败后的 pending 必须得到重试（pending 优先级高于去重）
    expect(resize).toHaveBeenCalled();

    sched.dispose();
  });

  // 根因回归锁定（不变量 1）：实例级归属，新调度器不得继承上一个终端的去重基线。
  // 组件级归属（旧 TerminalViewBase 手抄版）把 lastCols/rows 存在 useRef 上，
  // 跨 cacheKey 存活 → tab B 的首次同步被吞 → PTY 收不到 → 格式混乱。
  //
  // 配套的不变量 2（在途不重发）见上方「在途 resize 未回执」用例 —— 两者正交，
  // 只满足其一都会出 bug。
  it('去重状态按终端归属：复用的 entry 被新调度器接管后不继承旧调度器的去重基线', async () => {
    const h = makeEntry(80, 24, 'sid');
    h.entry.fitAddon.fit = vi.fn(() => h.setColsRows(100, 30));
    const resize = vi.fn(() => Promise.resolve());

    // 第一个调度器（旧 tab）把 100x30 同步到 PTY
    const schedA = createFitScheduler({ getEntry: () => h.entry, resize });
    schedA.scheduleFit();
    flushRaf();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith('sid', 100, 30);
    schedA.dispose();

    // tab 切换：cleanup 销毁旧调度器，attach 为新 tab 新建调度器
    const schedB = createFitScheduler({ getEntry: () => h.entry, resize });
    // 新调度器的 fit 收敛（尺寸未变），但去重基线必须为空 → 必须重新同步
    h.entry.fitAddon.fit = vi.fn(() => {});
    schedB.scheduleFit();
    flushRaf();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    // 若去重状态按组件归属（跨调度器共享），这里会被早退闸吃掉 → resize 停在 1 次
    expect(resize).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenLastCalledWith('sid', 100, 30);

    schedB.dispose();
  });

  // 回归锁定：删除 `converged` 早退闸后，必须在**在途 resize 未回执**时仍去重。
  //
  // scheduleFit 同时挂 RAF 与 120ms trailing 两个 doFit。RAF 那次发出 resize 后
  // lastCols 尚未更新（promise 未 resolve），trailing 那次若只比 lastCols 会再次
  // 发出同一个 resize —— 重复 resize 事件正是 e9af28e4 专门修复的格式混乱来源。
  it('在途 resize 未回执时，trailing 那一次不得重复发送同一尺寸', async () => {
    const h = makeEntry(80, 24, 'sid');
    // fit 第一次把网格改到 100x30，之后收敛
    let fitted = false;
    h.entry.fitAddon.fit = vi.fn(() => {
      if (!fitted) {
        fitted = true;
        h.setColsRows(100, 30);
      }
    });
    // resize 永不 resolve —— 模拟慢 IPC（真实场景：跨 WSL/SSH 的 resize_terminal）
    const resize = vi.fn(() => new Promise<void>(() => {}));
    const sched = createFitScheduler({ getEntry: () => h.entry, resize });

    sched.scheduleFit();
    // RAF 那次：发出 resize(100,30)
    flushRaf();
    await Promise.resolve();
    expect(resize).toHaveBeenCalledTimes(1);

    // trailing 那次：fit 已收敛（仍 100x30），但前一个 resize 还在途
    await vi.advanceTimersByTimeAsync(120);
    // 不得重复发送同一尺寸
    expect(resize).toHaveBeenCalledTimes(1);

    sched.dispose();
  });

  it('旧调度器 dispose 后其去重状态不再影响新调度器', async () => {
    const h = makeEntry(80, 24, 'sid');
    const resize = vi.fn(() => Promise.resolve());
    const schedA = createFitScheduler({ getEntry: () => h.entry, resize });
    schedA.scheduleFit();
    flushRaf();
    await Promise.resolve();
    schedA.dispose();

    // 新调度器：无边角案例共享，从零开始
    const schedB = createFitScheduler({ getEntry: () => h.entry, resize });
    expect(schedB._getState()).toEqual({
      lastCols: -1,
      lastRows: -1,
      inFlightCols: null,
      inFlightRows: null,
      pendingCols: null,
      pendingRows: null,
    });
    schedB.dispose();
  });
});
