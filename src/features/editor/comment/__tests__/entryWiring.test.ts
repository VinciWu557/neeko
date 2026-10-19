// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * 入口接线的**静态护栏**（方案 A：编辑器内工具条）。
 *
 * ## 为什么必须有这一条
 *
 * 2026-10-19 实证：把 `FileEditor.tsx` 里整段 `<CommentTranslationBar ... />` 删掉，
 * **928 个前端测试全绿**。功能存在、可调用、有 470+ 条单测背书，但**入口没挂**——
 * 用户永远看不到按钮。这与 AC16 的「运行时测不出消失了什么」同型：
 * 渲染层测得到 widget，测不到「谁把它挂上去」。
 *
 * 同理，`CommentTranslationBar` 里的 `canEdit` / `supported` 门控删掉也全绿：
 * 它是**条件**，没有用例覆盖「不该显示时不显示」。
 *
 * 判据选择：这里断言「组件出现在 FileEditor 的 JSX 里」，而不是渲染 FileEditor
 * （后者要构造 tab / store / CodeMirror 一整套，脆弱且慢）。静态断言能精确表达
 * 「接线存在」这一事实，是本仓库 `editorWiring.test.ts` 已验证的模式。
 */
const FILE_EDITOR = 'src/features/editor/components/FileEditor.tsx';
const BAR = 'src/features/editor/components/CommentTranslationBar.tsx';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** 剥掉注释行 —— 注释里提到反例是合法的，不能算违规。 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

describe('entryWiring / 注释翻译入口（方案 A）', () => {
  it('should import the bar into FileEditor', () => {
    expect(read(FILE_EDITOR)).toMatch(
      /import CommentTranslationBar from '\.\/CommentTranslationBar'/,
    );
  });

  it('should actually render the bar inside FileEditor', () => {
    // 核心判据：光 import 不算接线 —— 删掉 JSX 后 import 还在，功能却没了。
    expect(codeOnly(read(FILE_EDITOR))).toContain('<CommentTranslationBar');
  });

  it('should pass the four required props to the bar', () => {
    const source = read(FILE_EDITOR);
    const missing = ['filePath=', 'projectId=', 'editorViewRef=', 'content=', 'canEdit='].filter(
      (prop) => !source.includes(prop),
    );
    expect(missing).toEqual([]);
  });

  it('should keep the canEdit / supported gate in the bar', () => {
    // 变异实证：删掉这一行门控，928 个测试仍全绿 —— 没有它，只读文件和 markdown
    // 也会长出「翻译注释」按钮，点了什么都不会发生（静默失败）。
    const source = codeOnly(read(BAR));
    expect(source).toMatch(/if \(!canEdit \|\| !actions\.supported\) return null;/);
  });

  it('should not hardcode the display mode union a second time', () => {
    // CommentTranslationDefaults 曾把 'below'|'inline'|'hover'|'off' 抄第二份（双源）。
    // 现在默认项直接取 AppConfig.translation，类型来自 CommentDisplayMode。
    expect(codeOnly(read(BAR))).toContain('config.translation');
  });

  it('should keep the bar mounted outside the editor view (no props drilling of translation data)', () => {
    // 译文数据不得经 FileEditor 透传 —— 那是 reconfigure 风险面（AC16 / 禁止模式 10）。
    const source = read(FILE_EDITOR);
    expect(source).not.toMatch(/setCommentTranslations/);
    expect(source).not.toMatch(/commentTranslationField/);
  });
});
