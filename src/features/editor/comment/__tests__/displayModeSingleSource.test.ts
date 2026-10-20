// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `CommentDisplayMode` 的**单一事实源**（静态护栏）。
 *
 * ## 为什么需要
 *
 * 这个联合类型曾是两份：`shared/types/settings.ts` 的配置契约与
 * `editor/comment/commentTranslations.ts` 的渲染模式各写一遍。加一种显示模式
 * （比如 `gutter`）要改两处，漏一处**不产生编译错误** —— 配置能选到、渲染层不认。
 *
 * 2026-10 重构时我在 `EditorPanel` 里又手写了第三份（三处：prop 类型、回调签名、
 * 事件转换）。本护栏把「不得再手写」变成机器判据。
 */
const ROOTS = ['src/features', 'src/shared'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** 剥掉注释，避免文档里举例被当成违规。 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

describe('CommentDisplayMode 单一事实源', () => {
  it('should be defined exactly once (in shared/types/settings.ts)', () => {
    const definition = /export type CommentDisplayMode\s*=/;
    const hits = ROOTS.flatMap((root) => walk(root))
      .filter((file) => definition.test(codeOnly(readFileSync(file, 'utf8'))))
      .map((file) => file.replace(/\\/g, '/'));

    expect(hits).toEqual(['src/shared/types/settings.ts']);
  });

  it('should not re-spell the union inline anywhere except the definition', () => {
    // 手写联合的指纹：三个取值用 | 串起来。**排除定义行本身** ——
    // 否则这条护栏只会指着它自己该允许的那一行。
    const inline = /'below'\s*\|\s*'inline'\s*\|\s*'hover'/;
    const isDefinition = /export type CommentDisplayMode\s*=/;

    const offenders = ROOTS.flatMap((root) => walk(root))
      .filter((file) => {
        const code = codeOnly(readFileSync(file, 'utf8'));
        if (!inline.test(code)) return false;
        // 一个文件可能同时含定义与复用；逐行判断更准
        return code.split('\n').some((line) => inline.test(line) && !isDefinition.test(line));
      })
      .map((file) => file.replace(/\\/g, '/'));

    expect(offenders).toEqual([]);
  });

  it('should let the render layer reuse it rather than redeclare', () => {
    const source = readFileSync('src/features/editor/comment/commentTranslations.ts', 'utf8');
    expect(source).toMatch(/from '@\/shared\/types\/settings'/);
  });
});
