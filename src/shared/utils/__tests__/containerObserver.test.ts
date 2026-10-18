import { describe, expect, it, vi } from 'vitest';

import {
  CONTAINER_OBSERVE_EPSILON,
  observeContainerSize,
  type ContainerObserver,
} from '../containerObserver';

/** 最小 ResizeObserver 替身：手动 feed entries。 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  cb: ResizeObserverCallback;

  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element) {
    this.observed.push(target);
  }

  unobserve(target: Element) {
    this.observed = this.observed.filter((t) => t !== target);
  }

  disconnect() {
    this.disconnected = true;
    this.observed = [];
  }

  fire(entries: ResizeObserverEntry[]) {
    this.cb(entries, this as unknown as ResizeObserver);
  }

  static reset() {
    FakeResizeObserver.instances = [];
  }
}

function makeEntry(width: number, height: number): ResizeObserverEntry {
  return { contentRect: { width, height } } as ResizeObserverEntry;
}

/** rAF 队列替身：不自动执行，由测试手动 flush。cancel 真正移除队列项。 */
function makeRaf() {
  const queue: FrameRequestCallback[] = [];
  const raf = vi.fn((cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  });
  const cancel = vi.fn((handle: number) => {
    // 模拟真实 cancelAnimationFrame：按句柄（1-based index）移除
    const idx = handle - 1;
    if (idx >= 0 && idx < queue.length) queue.splice(idx, 1);
  });
  return {
    raf: raf as unknown as typeof requestAnimationFrame,
    cancel: cancel as unknown as typeof cancelAnimationFrame,
    flush() {
      const q = [...queue];
      queue.length = 0;
      q.forEach((cb) => cb(0));
    },
    pending: () => queue.length,
  };
}

function setup() {
  FakeResizeObserver.reset();
  const onResize = vi.fn();
  const raf = makeRaf();
  const observer: ContainerObserver = observeContainerSize({
    onResize,
    ResizeObserverCtor: FakeResizeObserver as unknown as typeof ResizeObserver,
    requestAnimationFrameFn: raf.raf,
    cancelAnimationFrameFn: raf.cancel,
  });
  const target = {} as Element;
  observer.observe(target);
  const ro = FakeResizeObserver.instances[0];
  return { observer, onResize, raf, ro, target };
}

describe('observeContainerSize', () => {
  it('首帧尺寸变化触发 onResize（经 rAF 合帧，不同步执行）', () => {
    const { onResize, raf, ro } = setup();

    ro.fire([makeEntry(800, 600)]);
    // rAF 未 flush 前不得执行 —— 同步执行会把 fit() 放进 RO 回调，重新触发反馈环
    expect(onResize).not.toHaveBeenCalled();

    raf.flush();
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it('尺寸变化 < 1px 判为子元素噪声，直接忽略（断反馈环）', () => {
    const { onResize, raf, ro } = setup();

    ro.fire([makeEntry(800, 600)]);
    raf.flush();
    expect(onResize).toHaveBeenCalledTimes(1);

    // 亚像素抖动：宽度 +0.4 / 高度 -0.3，均低于阈值
    ro.fire([makeEntry(800.4, 599.7)]);
    raf.flush();
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(raf.pending()).toBe(0);
  });

  it('刚好越过阈值即放行（边界为 >= 而非 >）', () => {
    const { onResize, raf, ro } = setup();

    ro.fire([makeEntry(800, 600)]);
    raf.flush();

    // 高度精确变化 = 阈值：应视为真实尺寸变化
    ro.fire([makeEntry(800, 600 + CONTAINER_OBSERVE_EPSILON)]);
    raf.flush();
    expect(onResize).toHaveBeenCalledTimes(2);
  });

  it('连续尺寸变化只保留最后一帧（rAF 取消前一次）', () => {
    const { onResize, raf, ro } = setup();

    ro.fire([makeEntry(800, 600)]);
    ro.fire([makeEntry(900, 600)]);
    ro.fire([makeEntry(1000, 700)]);

    raf.flush();
    // 三次变化合帧为一次 onResize，且前两次 rAF 已取消
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(raf.cancel).toHaveBeenCalledTimes(2);
  });

  it('onResize 抛错不破坏观察器（后续通知仍可触发）', () => {
    FakeResizeObserver.reset();
    const onResize = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('fit failed');
      })
      .mockImplementation(() => undefined);
    const raf = makeRaf();
    const observer = observeContainerSize({
      onResize,
      ResizeObserverCtor: FakeResizeObserver as unknown as typeof ResizeObserver,
      requestAnimationFrameFn: raf.raf,
      cancelAnimationFrameFn: raf.cancel,
    });
    observer.observe({} as Element);
    const ro = FakeResizeObserver.instances[0];

    ro.fire([makeEntry(800, 600)]);
    expect(() => raf.flush()).toThrow('fit failed');

    // rAF 回调已被消费（rafId 归 null），下一轮通知仍可调度
    ro.fire([makeEntry(900, 700)]);
    raf.flush();
    expect(onResize).toHaveBeenCalledTimes(2);
  });

  it('disconnect：断开 RO 并取消未决 rAF', () => {
    const { onResize, raf, ro, observer } = setup();

    ro.fire([makeEntry(800, 600)]);
    expect(raf.pending()).toBe(1);

    observer.disconnect();

    expect(ro.disconnected).toBe(true);
    expect(raf.cancel).toHaveBeenCalled();
    raf.flush();
    expect(onResize).not.toHaveBeenCalled();
  });

  it('空 entries / 无 contentRect 时不抛错', () => {
    const { raf, ro } = setup();

    expect(() => {
      ro.fire([]);
      raf.flush();
    }).not.toThrow();
  });

  it('disconnect 幂等：重复调用不抛错', () => {
    const { observer } = setup();

    expect(() => {
      observer.disconnect();
      observer.disconnect();
    }).not.toThrow();
  });
});
