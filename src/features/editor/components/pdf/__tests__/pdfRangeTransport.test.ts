import { describe, expect, it, vi } from 'vitest';

import {
  bindRangeTransport,
  normalizeRange,
  type DataRangeTransportLike,
} from '@/features/editor/components/pdf/pdfRangeTransport';

function fakeTransport(): DataRangeTransportLike & {
  onDataRange: ReturnType<typeof vi.fn>;
} {
  return {
    requestDataRange: () => {},
    onDataRange: vi.fn(),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('bindRangeTransport', () => {
  it('requestDataRange 翻译成取字节并回填同一区间', async () => {
    const transport = fakeTransport();
    const fetchRange = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    bindRangeTransport(transport, fetchRange);

    transport.requestDataRange(10, 13);
    await tick();

    expect(fetchRange).toHaveBeenCalledWith(10, 13);
    expect(transport.onDataRange).toHaveBeenCalledWith(10, new Uint8Array([1, 2, 3]));
  });

  it('乱序到达的响应按各自的 begin 回填，不串数据', async () => {
    const transport = fakeTransport();
    const resolvers: Record<number, (v: Uint8Array) => void> = {};
    const fetchRange = vi.fn(
      (begin: number) =>
        new Promise<Uint8Array>((resolve) => {
          resolvers[begin] = resolve;
        }),
    );
    bindRangeTransport(transport, fetchRange);

    transport.requestDataRange(100, 110);
    transport.requestDataRange(200, 210);
    // 后发先至
    resolvers[200](new Uint8Array([2]));
    resolvers[100](new Uint8Array([1]));
    await tick();

    expect(transport.onDataRange).toHaveBeenNthCalledWith(1, 200, new Uint8Array([2]));
    expect(transport.onDataRange).toHaveBeenNthCalledWith(2, 100, new Uint8Array([1]));
  });

  it('失败时回填 null 并上报错误（不永久挂起）', async () => {
    const transport = fakeTransport();
    const onError = vi.fn();
    bindRangeTransport(transport, () => Promise.reject(new Error('boom')), { onError });

    transport.requestDataRange(4, 8);
    await tick();

    expect(transport.onDataRange).toHaveBeenCalledWith(4, null);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 4);
  });

  it('abort 之后不再回填（卸载后晚到的字节必须丢弃）', async () => {
    const transport = fakeTransport();
    let resolveLate: (v: Uint8Array) => void = () => {};
    const fetchRange = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          resolveLate = resolve;
        }),
    );
    const abort = bindRangeTransport(transport, fetchRange);

    transport.requestDataRange(0, 4);
    abort();
    resolveLate(new Uint8Array([9]));
    await tick();

    expect(transport.onDataRange).not.toHaveBeenCalled();
  });

  it('abort 之后的请求直接忽略，不再触发取字节', async () => {
    const transport = fakeTransport();
    const fetchRange = vi.fn().mockResolvedValue(new Uint8Array([1]));
    const abort = bindRangeTransport(transport, fetchRange);
    abort();

    transport.requestDataRange(0, 4);
    await tick();

    expect(fetchRange).not.toHaveBeenCalled();
  });
});

describe('normalizeRange', () => {
  const size = 1000;

  it('正常区间原样通过（end 不越界）', () => {
    expect(normalizeRange(100, 200, size)).toEqual({ begin: 100, length: 100 });
  });

  it('end 超出文件尾时夹取到文件大小', () => {
    expect(normalizeRange(900, 5000, size)).toEqual({ begin: 900, length: 100 });
  });

  it('begin 越界 / 空区间返回 null（由调用方回填 null）', () => {
    expect(normalizeRange(1000, 1100, size)).toBeNull();
    expect(normalizeRange(200, 200, size)).toBeNull();
    expect(normalizeRange(300, 200, size)).toBeNull();
  });

  it('非有限值返回 null', () => {
    expect(normalizeRange(Number.NaN, 10, size)).toBeNull();
    expect(normalizeRange(0, Number.POSITIVE_INFINITY, size)).toBeNull();
  });
});
