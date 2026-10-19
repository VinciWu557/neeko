// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * AC16 的**接线护栏**（静态断言）。
 *
 * 译文的正确形态是「模块级 field + view 放进稳定段，数据经 effect 推送」。
 * 一旦有人把译文数据接进 `useEditorExtensions` 的依赖数组，每批译文到达都会
 * 触发 `reconfigure`，把 lint 等惰性扩展静默丢弃 —— 表现是「波浪线消失」，
 * 且没有任何报错。这类回归只能靠静态断言拦（运行时测不出「本该存在的东西消失了」）。
 *
 * 参照：`quality-guidelines.md` 禁止模式 10；`lspDiagnosticsProjection` 的同类护栏思路。
 */
const EXT_FILE = 'src/features/editor/hooks/useEditorExtensions.ts';

function readExtensions(): string {
  return readFileSync(EXT_FILE, 'utf8');
}

describe('editorWiring / 注释译文装配（AC16）', () => {
  it('should mount the translation view (which self-contains the field)', () => {
    // `commentTranslationView()` 返回 `[field, plugin]` —— 自包含，
    // 避免调用方忘挂 field 导致 widget 静默不渲染（实测踩过）。
    const source = readExtensions();
    expect(source).toContain('commentTranslationView()');
  });

  it('should import it from the comment domain', () => {
    const source = readExtensions();
    expect(source).toMatch(/from '@\/features\/editor\/comment\/commentView'/);
  });

  it('should NOT take translation data as a prop of useEditorExtensions', () => {
    // 这是 AC16 的核心判据：译文数据一旦成为 props → 进依赖数组 → reconfigure
    const source = readExtensions();
    const propsBlock = source.slice(
      source.indexOf('interface UseEditorExtensionsParams'),
      source.indexOf('}', source.indexOf('interface UseEditorExtensionsParams')),
    );
    expect(propsBlock).not.toMatch(/translation/i);
    expect(propsBlock).not.toMatch(/entries/i);
    expect(propsBlock).not.toMatch(/commentTranslations/i);
  });

  it('should not DISPATCH setCommentTranslations from inside the extension memo', () => {
    // 装配处只挂扩展；推送必须来自控制器/调用方（否则 memo 内会产生副作用）。
    // 注意：注释里提到该名字是合法的 —— 断言「被调用」而非「被提及」。
    const source = readExtensions();
    expect(source).not.toMatch(/setCommentTranslations\.of\(/);
    expect(source).not.toMatch(/dispatch\(\s*\{[^}]*setCommentTranslations/);
  });

  it('should keep the translation extensions outside the reconfigure-prone dependency list', () => {
    // 断言：field / view 的装配行不在 useMemo 的依赖数组里被引用
    const source = readExtensions();
    const depArrayStart = source.lastIndexOf('  }, [');
    const depArray = source.slice(depArrayStart, source.indexOf(']);', depArrayStart));
    expect(depArray).not.toContain('commentTranslationField');
    expect(depArray).not.toContain('commentTranslationView');
  });
});
