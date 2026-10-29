import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_ASSET_BYTES,
  readFileBytes,
  readFileBytesAll,
  readFileRange,
  readFileSize,
} from '@/shared/api/fileBytes';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';
import { invoke } from '@/testing/tauriCore';

// `invoke` 由 `src/testing/setup.ts` 全局 mock；这里只操作它的实现。
const invokeMock = vi.mocked(invoke);

const workspace = WorkspaceSession.of('p1', null);

/** 把整份字节按 `chunk` 大小分片喂给 `read_file_bytes` 的实现（模拟后端单次载荷上界）。 */
function serveChunks(total: Uint8Array, chunk: number) {
  return (offset: number | null, length: number | null): Promise<ArrayBuffer> => {
    const start = offset ?? 0;
    const want = Math.min(length ?? total.byteLength - start, chunk);
    return Promise.resolve(total.slice(start, start + want).buffer as ArrayBuffer);
  };
}

function bytesInvokeCalls() {
  return invokeMock.mock.calls.filter(([cmd]) => cmd === 'read_file_bytes');
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe('readFileBytes / readFileSize 的传参形态', () => {
  it('相对路径与基准目录一起传给后端（不拍平成绝对路径）', async () => {
    invokeMock.mockResolvedValue(new ArrayBuffer(1));
    await readFileBytes(workspace, 'img/a.png', { base: '/repo/docs', offset: 10, length: 5 });

    expect(invokeMock).toHaveBeenCalledWith('read_file_bytes', {
      workspace,
      filePath: 'img/a.png',
      base: '/repo/docs',
      offset: 10,
      length: 5,
    });
  });

  it('缺省参数以 null 下发（range 语义的「不传」必须显式）', async () => {
    invokeMock.mockResolvedValue(new ArrayBuffer(0));
    await readFileBytes(workspace, 'a.png');

    expect(invokeMock).toHaveBeenCalledWith('read_file_bytes', {
      workspace,
      filePath: 'a.png',
      base: null,
      offset: null,
      length: null,
    });
  });

  it('readFileSize 走 stat 通道并带同样的 base', async () => {
    invokeMock.mockResolvedValue(42);
    await expect(readFileSize(workspace, 'a.pdf', { base: '/repo' })).resolves.toBe(42);
    expect(invokeMock).toHaveBeenCalledWith('read_file_size', {
      workspace,
      filePath: 'a.pdf',
      base: '/repo',
    });
  });
});

describe('readFileRange — 短读续读（后端「至多返回」契约的消费侧）', () => {
  it('一次拿到短块时按返回长度推进，最终读满请求区间', async () => {
    const total = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    invokeMock.mockImplementation((cmd: string, args: Record<string, number | null>) =>
      cmd === 'read_file_bytes'
        ? serveChunks(total, 3)(args.offset ?? null, args.length ?? null)
        : Promise.reject(new Error(`unexpected ${cmd}`)),
    );

    const out = await readFileRange(workspace, 'a.pdf', { begin: 2, end: 9 });

    expect(Array.from(out)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    // 3 字节分片 ⇒ [2,9) 需要 3 次请求；每次都带「还差多少」，不复制后端上界常量
    expect(bytesInvokeCalls().map(([, args]) => args.offset)).toEqual([2, 5, 8]);
    expect(bytesInvokeCalls().map(([, args]) => args.length)).toEqual([7, 4, 1]);
  });

  it('空区间直接返回空数组，不发请求', async () => {
    const out = await readFileRange(workspace, 'a.pdf', { begin: 5, end: 5 });
    expect(out.byteLength).toBe(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('读到 EOF 仍未填满 ⇒ 明确报错（文件被并发截断，不能静默给半截数据）', async () => {
    invokeMock.mockImplementation((cmd: string, args: Record<string, number | null>) =>
      cmd === 'read_file_bytes'
        ? Promise.resolve(new Uint8Array(args.offset === 0 ? [1, 2] : []).buffer)
        : Promise.reject(new Error(`unexpected ${cmd}`)),
    );

    await expect(readFileRange(workspace, 'a.pdf', { begin: 0, end: 10 })).rejects.toThrow(
      /Unexpected end of file/,
    );
  });
});

describe('readFileBytesAll — 整读（图片等资产）', () => {
  it('先探大小再分片读满，任意大小都不受单次上界影响', async () => {
    const total = new Uint8Array(Array.from({ length: 7 }, (_, i) => i));
    invokeMock.mockImplementation((cmd: string, args: Record<string, number | null>) => {
      if (cmd === 'read_file_size') return Promise.resolve(total.byteLength);
      return serveChunks(total, 3)(args.offset ?? null, args.length ?? null);
    });

    const buf = await readFileBytesAll(workspace, 'img/big.png', { base: '/repo' });

    expect(Array.from(new Uint8Array(buf))).toEqual(Array.from(total));
    expect(invokeMock.mock.calls[0][0]).toBe('read_file_size');
  });

  it('超过预览上限时在传输前就失败（不把 webview 打爆）', async () => {
    invokeMock.mockResolvedValue(MAX_ASSET_BYTES + 1);
    await expect(readFileBytesAll(workspace, 'img/huge.png')).rejects.toThrow(/preview limit/);
    expect(bytesInvokeCalls()).toHaveLength(0);
  });

  it('空文件返回空 buffer（不触发读循环）', async () => {
    invokeMock.mockResolvedValue(0);
    const buf = await readFileBytesAll(workspace, 'img/empty.png');
    expect(buf.byteLength).toBe(0);
    expect(bytesInvokeCalls()).toHaveLength(0);
  });
});
