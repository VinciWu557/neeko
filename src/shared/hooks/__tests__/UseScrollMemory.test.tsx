import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  __resetScrollMemoryForTest,
  buildScrollKey,
  readScrollMemory,
  writeScrollMemory,
} from '@/shared/utils/scrollMemory';

import { useScrollMemory } from '../useScrollMemory';

const KEY = buildScrollKey('test.surface');

/**
 * jsdom 无布局：为元素安装可控的尺寸与 scrollTop/scrollTo。
 * scrollTo 写回真实值并派发 scroll —— 镜像浏览器语义（同 VirtualList.test.tsx 的 stub 范式）。
 */
function stubScrollBox(
  el: HTMLElement,
  init: { scrollTop: number; clientHeight: number; scrollHeight: number },
) {
  let scrollTop = init.scrollTop;
  let clientHeight = init.clientHeight;
  let scrollHeight = init.scrollHeight;
  Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });
  el.scrollTo = ((opts: ScrollToOptions) => {
    scrollTop = opts.top ?? 0;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  }) as unknown as HTMLElement['scrollTo'];
  return {
    setHeight: (h: number) => {
      clientHeight = h;
    },
    setScrollHeight: (h: number) => {
      scrollHeight = h;
    },
    setTop: (t: number) => {
      scrollTop = t;
    },
    getTop: () => scrollTop,
  };
}

/** 可捕获回调的 fake ResizeObserver（替换 setup.ts 的 no-op stub）。 */
function installCapturingRO() {
  const callbacks: ResizeObserverCallback[] = [];
  class ROCapture {
    observe() {}
    unobserve() {}
    disconnect() {}
    constructor(cb: ResizeObserverCallback) {
      callbacks.push(cb);
    }
  }
  const prev = globalThis.ResizeObserver;
  globalThis.ResizeObserver = ROCapture as unknown as typeof ResizeObserver;
  return {
    fire: () => {
      act(() => {
        for (const cb of callbacks)
          cb([] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
      });
    },
    restore: () => {
      globalThis.ResizeObserver = prev;
    },
  };
}

/** 等一帧：覆盖 hook 内的 rAF 兜底恢复。 */
const nextFrame = () =>
  act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });

/** 等微任务 + 宏任务队列：覆盖 MutationObserver 回调。 */
const flush = () =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

function Harness({ scrollKey, enabled = true }: { scrollKey: string | null; enabled?: boolean }) {
  const ref = useScrollMemory<HTMLDivElement>(scrollKey, { enabled });
  return <div ref={ref} data-testid="scroller" className="overflow-y-auto" />;
}

describe('useScrollMemory', () => {
  beforeEach(() => {
    __resetScrollMemoryForTest();
  });

  it('卸载重建后恢复位置（非活跃 tab 互切路径）', async () => {
    writeScrollMemory(KEY, 300);
    const view = render(<Harness scrollKey={KEY} />);
    stubScrollBox(screen.getByTestId('scroller'), {
      scrollTop: 0,
      clientHeight: 100,
      scrollHeight: 5000,
    });
    await nextFrame();
    expect(screen.getByTestId('scroller').scrollTop).toBe(300);
    view.unmount();

    render(<Harness scrollKey={KEY} />);
    stubScrollBox(screen.getByTestId('scroller'), {
      scrollTop: 0,
      clientHeight: 100,
      scrollHeight: 5000,
    });
    await nextFrame();
    expect(screen.getByTestId('scroller').scrollTop).toBe(300);
  });

  it('内容异步到达后追平（diff tab：挂载时内容为空）', async () => {
    writeScrollMemory(KEY, 300);
    render(<Harness scrollKey={KEY} />);
    const el = screen.getByTestId('scroller');
    const box = stubScrollBox(el, { scrollTop: 0, clientHeight: 100, scrollHeight: 0 });
    await nextFrame(); // 内容未撑开 → 进入等待，不落位
    expect(el.scrollTop).toBe(0);

    box.setScrollHeight(5000);
    act(() => {
      el.appendChild(document.createElement('div')); // 触发 MutationObserver
    });
    await flush();
    expect(el.scrollTop).toBe(300);
  });

  it('用户主动滚动后放弃追平（不与用户抢滚动条）', async () => {
    writeScrollMemory(KEY, 300);
    render(<Harness scrollKey={KEY} />);
    const el = screen.getByTestId('scroller');
    const box = stubScrollBox(el, { scrollTop: 0, clientHeight: 100, scrollHeight: 0 });
    act(() => {
      el.dispatchEvent(new Event('wheel', { bubbles: true }));
    });
    box.setScrollHeight(5000);
    act(() => {
      el.appendChild(document.createElement('div'));
    });
    await flush();
    await nextFrame();
    expect(el.scrollTop).toBe(0);
  });

  it('显示↔隐藏往返后写回位置（Dock 保活互切：引擎隐藏期丢 scrollTop）', async () => {
    const ro = installCapturingRO();
    try {
      writeScrollMemory(KEY, 300);
      render(<Harness scrollKey={KEY} />);
      const el = screen.getByTestId('scroller');
      const box = stubScrollBox(el, { scrollTop: 0, clientHeight: 100, scrollHeight: 5000 });
      await nextFrame();
      expect(box.getTop()).toBe(300); // 初始恢复

      // 切走：容器高度 0（display:none 语义）
      box.setHeight(0);
      ro.fire();
      box.setTop(0); // 模拟 WKWebView 在隐藏期丢弃位置

      // 切回：高度恢复 → 写回隐藏前位置
      box.setHeight(100);
      ro.fire();
      expect(box.getTop()).toBe(300);
    } finally {
      ro.restore();
    }
  });

  it('可见滚动实时采集', async () => {
    const ro = installCapturingRO();
    try {
      render(<Harness scrollKey={KEY} />);
      const el = screen.getByTestId('scroller');
      const box = stubScrollBox(el, { scrollTop: 0, clientHeight: 100, scrollHeight: 5000 });
      ro.fire(); // 容器可见
      box.setTop(120);
      act(() => {
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      expect(readScrollMemory(KEY)).toBe(120);
    } finally {
      ro.restore();
    }
  });

  it('恢复未完成时卸载：保留目标意图（异步内容切走再回来）', async () => {
    writeScrollMemory(KEY, 300);
    const view = render(<Harness scrollKey={KEY} />);
    stubScrollBox(screen.getByTestId('scroller'), {
      scrollTop: 0,
      clientHeight: 100,
      scrollHeight: 0,
    });
    await nextFrame(); // 内容未撑开 → pending 保持
    view.unmount();
    expect(readScrollMemory(KEY)).toBe(300); // 未被 clamp 中间态污染
  });

  it('enabled=false 作废既有记忆且不恢复', async () => {
    writeScrollMemory(KEY, 300);
    render(<Harness scrollKey={KEY} enabled={false} />);
    stubScrollBox(screen.getByTestId('scroller'), {
      scrollTop: 0,
      clientHeight: 100,
      scrollHeight: 5000,
    });
    await nextFrame();
    expect(screen.getByTestId('scroller').scrollTop).toBe(0);
    expect(readScrollMemory(KEY)).toBeUndefined();
  });

  it('key=null：仅进程内镜像 —— display:none 往返写回生效，但不落 KV', async () => {
    const ro = installCapturingRO();
    try {
      render(<Harness scrollKey={null} />);
      const el = screen.getByTestId('scroller');
      const box = stubScrollBox(el, { scrollTop: 0, clientHeight: 100, scrollHeight: 5000 });
      ro.fire(); // 建立可见性（jsdom 无布局：装桩前 offsetHeight 为 0，hook 视作隐藏）

      box.setTop(150);
      act(() => {
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      });

      box.setHeight(0); // 切走
      ro.fire();
      box.setTop(0); // 引擎隐藏期丢位置
      box.setHeight(100); // 切回
      ro.fire();

      expect(box.getTop()).toBe(150); // 写回仍生效
      expect(readScrollMemory(KEY)).toBeUndefined(); // 但未落缓存
    } finally {
      ro.restore();
    }
  });

  it('显示恢复被 layout-effect 竞争写入清零 → 帧内复核写回镜像（tanstack enabled 恢复场景）', async () => {
    const ro = installCapturingRO();
    try {
      writeScrollMemory(KEY, 300);
      render(<Harness scrollKey={KEY} />);
      const el = screen.getByTestId('scroller');
      const box = stubScrollBox(el, { scrollTop: 0, clientHeight: 100, scrollHeight: 5000 });
      await nextFrame();
      expect(box.getTop()).toBe(300); // 初始恢复

      box.setHeight(0);
      ro.fire();
      box.setTop(0); // 引擎隐藏期丢位置
      box.setHeight(100);
      ro.fire();
      expect(box.getTop()).toBe(300); // 同步写回

      // 竞争写入者（tanstack 恢复 enabled 时写 initialOffset=0）覆盖同步写 + 派发 scroll
      box.setTop(0);
      act(() => {
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      expect(box.getTop()).toBe(0); // 此刻确实被清零
      expect(readScrollMemory(KEY)).toBe(300); // 恢复在途：镜像未被污染

      await nextFrame(); // 帧内复核落位
      expect(box.getTop()).toBe(300);
    } finally {
      ro.restore();
    }
  });
});
