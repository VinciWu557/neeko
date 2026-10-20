// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * 入口接线的**静态护栏**（方案 B：编辑器头部图标按钮）。
 *
 * ## 为什么必须有这一条
 *
 * 2026-10-19 实证：把 `FileEditor.tsx` 里整段入口组件删掉，**928 个前端测试全绿**。
 * 功能存在、可调用、有数百条单测背书，但**入口没挂** —— 用户永远看不到按钮。
 * 渲染层测得到 widget，测不到「谁把它挂上去」。
 *
 * 本轮（从常驻工具条改为头部图标按钮）同样换了三层接线，每层都可能静默断掉：
 *
 * ```
 * FileEditor  →  FileEditorView  →  EditorHeader  →  CommentTranslationButton
 *   props          props              JSX 挂载          门控
 * ```
 *
 * ## 判据选择
 *
 * 断言「组件出现在 JSX 里 + 关键门控仍存在」，而不是渲染整套
 * （后者要构造 tab / store / CodeMirror，脆弱且慢）。同 `editorWiring.test.ts` 的模式。
 */
const FILE_EDITOR = 'src/features/editor/components/FileEditor.tsx';
const FILE_EDITOR_VIEW = 'src/features/editor/components/FileEditorView.tsx';
const EDITOR_HEADER = 'src/features/editor/components/EditorHeader.tsx';
const BUTTON = 'src/features/editor/components/CommentTranslationButton.tsx';

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

describe('entryWiring / 注释翻译入口（头部图标按钮）', () => {
  it('should render the button inside EditorHeader next to the search button', () => {
    // 核心判据：光定义组件不算接线。
    const source = codeOnly(read(EDITOR_HEADER));
    expect(source).toContain('<CommentTranslationButton');
    // 「搜索旁边」是产品要求，不是实现细节：入口必须落在同一个按钮栏里，
    // 位置错了用户就找不到（它否则会混进面包屑区）。
    const searchIdx = source.indexOf('{onSearch && (');
    const buttonIdx = source.indexOf('<CommentTranslationButton');
    expect(searchIdx).toBeGreaterThan(-1);
    expect(buttonIdx).toBeGreaterThan(searchIdx);
  });

  it('should gate the header entry on editability and non-preview', () => {
    // 变异实证：门控删掉后只读文件与预览模式也会长出按钮，点了什么都不会发生。
    const source = codeOnly(read(FILE_EDITOR_VIEW));
    expect(source).toMatch(/commentTranslation=\{/);
    expect(source).toMatch(/canEdit &&/);
  });

  it('should pass the editor view ref through FileEditorView', () => {
    // 拿不到 EditorView 就取不到 syntaxTree —— 按钮会渲染但永远翻不了。
    expect(read(FILE_EDITOR_VIEW)).toMatch(/editorViewRef:\s*React\.MutableRefObject/);
    expect(codeOnly(read(FILE_EDITOR_VIEW))).toContain('editorViewRef,');
    expect(codeOnly(read(FILE_EDITOR))).toContain('editorViewRef={editorViewRef}');
  });

  it('should keep the supported gate in the button', () => {
    // 语言无注释语义（如 .json）时不得显示入口。
    expect(codeOnly(read(BUTTON))).toMatch(/if \(!actions\.supported\) return null;/);
  });

  it('should wire the click to start / stop (plan A, no intermediate menu)', () => {
    const source = codeOnly(read(BUTTON));
    expect(source).toContain('actions.stop()');
    expect(source).toContain('actions.start()');
  });

  it('should keep the auto-warm switch wired (config → effect)', () => {
    // `commentAutoWarm` 曾在 settings 与 normalize 里定义但全仓无读取方 ——
    // 开关建好没通电。这条防它再退回去。
    const source = codeOnly(read(BUTTON));
    expect(source).toContain('commentAutoWarm');
    expect(source).toMatch(/lastWarmedFileRef/);
  });

  it('should read defaults from AppConfig.translation (single source, no second union copy)', () => {
    // CommentTranslationDefaults 曾把 'below'|'inline'|'hover'|'off' 抄第二份（双源）。
    expect(codeOnly(read(BUTTON))).toContain('config.translation');
  });

  it('should not drill translation data through FileEditor (reconfigure risk surface)', () => {
    // 译文数据不得经 FileEditor 透传 —— 那是 reconfigure 风险面（AC16 / 禁止模式 10）。
    const source = read(FILE_EDITOR);
    expect(source).not.toMatch(/setCommentTranslations/);
    expect(source).not.toMatch(/commentTranslationField/);
  });

  it('should not reintroduce a permanent toolbar row', () => {
    // 本轮的产品决策：入口不再占一行垂直空间。这条防「顺手加回工具条」。
    const source = codeOnly(read(FILE_EDITOR));
    expect(source).not.toContain('CommentTranslationBar');
    expect(source).not.toContain('CommentTranslationToolbar');
  });
});
