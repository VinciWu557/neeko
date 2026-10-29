import { describe, expect, it } from 'vitest';

import { resolveMarkdownBasePath } from '@/shared/utils/localAsset';

/**
 * basePath 的选择规则是纯逻辑，单测钉住它；hook 只负责把 store 值喂进来
 * （`useAssetBasePath` 见 `src/shared/hooks/useAssetBasePath.ts`）。
 */
describe('resolveMarkdownBasePath', () => {
  it('显式 basePath 优先于项目根', () => {
    expect(resolveMarkdownBasePath('/skill/central', '/proj')).toBe('/skill/central');
  });

  it('无显式 basePath 时回落到项目根', () => {
    expect(resolveMarkdownBasePath(undefined, '/proj')).toBe('/proj');
    expect(resolveMarkdownBasePath('', '/proj')).toBe('/proj');
  });

  it('两者都缺时返回 undefined（不猜路径）', () => {
    expect(resolveMarkdownBasePath(undefined, null)).toBeUndefined();
    expect(resolveMarkdownBasePath('', undefined)).toBeUndefined();
  });
});
