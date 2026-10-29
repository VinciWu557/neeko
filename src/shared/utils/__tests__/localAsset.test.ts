import { describe, expect, it } from 'vitest';

import { isRemoteAssetSrc, normalizeAssetPath, resolveAssetUrl } from '@/shared/utils/localAsset';

// setup.ts 全局 mock 了 convertFileSrc：`asset://localhost/${path}`（path 原样，不加斜杠）。
const ASSET = (p: string) => `asset://localhost/${p}`;

describe('resolveAssetUrl', () => {
  it('http(s)/blob/asset 等协议原样直通', () => {
    expect(resolveAssetUrl('https://a.com/x.png', '/proj')).toBe('https://a.com/x.png');
    expect(resolveAssetUrl('http://a.com/x.png')).toBe('http://a.com/x.png');
    expect(resolveAssetUrl('blob:http://localhost/abc', '/proj')).toBe('blob:http://localhost/abc');
    expect(resolveAssetUrl('asset://localhost/a.png', '/proj')).toBe('asset://localhost/a.png');
  });

  it('协议相对 URL（//host/x.png）原样直通，不当成本地绝对路径', () => {
    // 与 <a> 侧 markdownLinks 同一规则；判成本地路径会让远程项目去读一个不存在的文件
    expect(resolveAssetUrl('//cdn.example.com/x.png', '/proj')).toBe('//cdn.example.com/x.png');
    expect(isRemoteAssetSrc('//cdn.example.com/x.png')).toBe(false);
  });

  it('data URI 有 basePath 时不被改写（旧正则在这里把 data: 拼进了 convertFileSrc）', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
    expect(resolveAssetUrl(dataUri, '/proj')).toBe(dataUri);
    expect(resolveAssetUrl(dataUri)).toBe(dataUri);
  });

  it('POSIX 绝对路径走 convertFileSrc，反斜杠归一为斜杠', () => {
    expect(resolveAssetUrl('/tmp/project/a.png', '/proj')).toBe(ASSET('/tmp/project/a.png'));
    expect(resolveAssetUrl('\\tmp\\project\\a.png')).toBe(ASSET('/tmp/project/a.png'));
  });

  it('Windows 盘符路径不被误判为协议（C: 形似 scheme）', () => {
    expect(resolveAssetUrl('C:\\proj\\a.png', '/proj')).toBe(ASSET('C:/proj/a.png'));
    expect(resolveAssetUrl('C:/proj/a.png')).toBe(ASSET('C:/proj/a.png'));
  });

  it('相对路径拼 basePath（含 ./ 前缀与反斜杠输入）', () => {
    expect(resolveAssetUrl('img/a.png', '/proj/docs')).toBe(ASSET('/proj/docs/img/a.png'));
    expect(resolveAssetUrl('./img/a.png', '/proj/docs/')).toBe(ASSET('/proj/docs/img/a.png'));
    expect(resolveAssetUrl('img\\a.png', 'C:\\proj')).toBe(ASSET('C:/proj/img/a.png'));
  });

  it('无 basePath 的相对路径原样返回（调用方用 alt 兜底，不做无意义改写）', () => {
    expect(resolveAssetUrl('img/a.png')).toBe('img/a.png');
    expect(resolveAssetUrl('./img/a.png')).toBe('./img/a.png');
  });

  it('空 src 返回空串', () => {
    expect(resolveAssetUrl('', '/proj')).toBe('');
  });
});

describe('isRemoteAssetSrc', () => {
  it('本地可渲染的协议与空值不算远程', () => {
    expect(isRemoteAssetSrc('https://a.com/x.png')).toBe(false);
    expect(isRemoteAssetSrc('data:image/png;base64,AA')).toBe(false);
    expect(isRemoteAssetSrc('blob:http://localhost/x')).toBe(false);
    expect(isRemoteAssetSrc('asset://localhost/a.png')).toBe(false);
    expect(isRemoteAssetSrc('')).toBe(false);
  });

  it('本地绝对/相对路径算远程候选（需要字节通道）', () => {
    expect(isRemoteAssetSrc('/tmp/a.png')).toBe(true);
    expect(isRemoteAssetSrc('C:\\proj\\a.png')).toBe(true);
    expect(isRemoteAssetSrc('img/a.png')).toBe(true);
  });
});

describe('normalizeAssetPath（URL 派生与 IPC 传参共用的归一）', () => {
  it('反斜杠归一为 `/`，去掉前导 `./`，去掉前后空白', () => {
    expect(normalizeAssetPath('  img\\a.png  ')).toBe('img/a.png');
    expect(normalizeAssetPath('./img/a.png')).toBe('img/a.png');
    expect(normalizeAssetPath('/abs/img/a.png')).toBe('/abs/img/a.png');
    expect(normalizeAssetPath('')).toBe('');
  });
});
