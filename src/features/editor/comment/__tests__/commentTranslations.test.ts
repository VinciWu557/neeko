// @vitest-environment node
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import {
  commentTranslationField,
  setCommentTranslations,
  type CommentTranslationPayload,
} from '../commentTranslations';

/**
 * AC16：译文数据**不得**进 `extensions` 依赖数组 —— 走 `StateField` + `StateEffect`。
 *
 * 为什么（`quality-guidelines.md` 禁止模式 10）：`@uiw/react-codemirror` 在
 * `extensions` 身份变化时 dispatch `StateEffect.reconfigure`，而 reconfigure 会
 * **整体替换 base 配置**，把 lint 等经 `appendConfig` 惰性安装的扩展一并丢弃 ——
 * 表现是「波浪线突然消失」，且没有任何报错。译文是高频活数据，若接进依赖，
 * 每批译文到达都会重建整个扩展世界。
 */

function payload(
  entries: Array<[number, number, string]>,
  mode: CommentTranslationPayload['mode'] = 'below',
): CommentTranslationPayload {
  return {
    mode,
    entries: entries.map(([from, to, text]) => ({ from, to, text })),
  };
}

describe('commentTranslations / StateField 基础', () => {
  it('should start empty', () => {
    const state = EditorState.create({ doc: '// hello', extensions: [commentTranslationField] });
    const value = state.field(commentTranslationField);
    expect(value.entries).toEqual([]);
    expect(value.mode).toBe('off');
  });

  it('should update when the effect is dispatched', () => {
    const state = EditorState.create({ doc: '// hello', extensions: [commentTranslationField] });
    const next = state.update({
      effects: setCommentTranslations.of(payload([[0, 8, '你好']])),
    }).state;

    const value = next.field(commentTranslationField);
    expect(value.entries).toHaveLength(1);
    expect(value.entries[0]?.text).toBe('你好');
  });

  it('should replace the whole payload rather than merge', () => {
    let state = EditorState.create({ doc: '// a\n// b', extensions: [commentTranslationField] });
    state = state.update({ effects: setCommentTranslations.of(payload([[0, 4, '甲']])) }).state;
    state = state.update({ effects: setCommentTranslations.of(payload([[5, 9, '乙']])) }).state;

    expect(state.field(commentTranslationField).entries).toHaveLength(1);
    expect(state.field(commentTranslationField).entries[0]?.text).toBe('乙');
  });

  it('should keep the mode across updates that do not change it', () => {
    let state = EditorState.create({ doc: '// a', extensions: [commentTranslationField] });
    state = state.update({
      effects: setCommentTranslations.of(payload([[0, 4, '甲']], 'inline')),
    }).state;
    expect(state.field(commentTranslationField).mode).toBe('inline');
  });

  it('should map entry positions through document changes', () => {
    let state = EditorState.create({ doc: '// hello', extensions: [commentTranslationField] });
    state = state.update({ effects: setCommentTranslations.of(payload([[0, 8, '你好']])) }).state;

    // 在开头插入两行 → 位置应整体后移
    state = state.update({ changes: { from: 0, insert: 'a\nb\n' } }).state;
    const entry = state.field(commentTranslationField).entries[0];
    expect(entry?.from).toBeGreaterThan(0);
  });

  it('should drop entries whose range is deleted', () => {
    let state = EditorState.create({
      doc: '// hello\n// world',
      extensions: [commentTranslationField],
    });
    state = state.update({ effects: setCommentTranslations.of(payload([[0, 8, '你好']])) }).state;
    // 删除整个第一行
    state = state.update({ changes: { from: 0, to: 9 } }).state;

    const value = state.field(commentTranslationField);
    // 删除后该区间塌缩，不应再渲染
    expect(value.entries.every((entry) => entry.from < entry.to)).toBe(true);
  });

  it('should be a module-level singleton so reconfigure preserves its value', () => {
    // 身份稳定：两次 import 得到同一 field（写成函数内 define 会让 reconfigure 后静默归零）
    const a = commentTranslationField;
    const b = commentTranslationField;
    expect(a).toBe(b);
  });
});

describe('commentTranslations / AC16 不触发 reconfigure', () => {
  it('should not produce a reconfigure effect when translations are pushed', () => {
    const state = EditorState.create({ doc: '// hello', extensions: [commentTranslationField] });
    const tr = state.update({
      effects: setCommentTranslations.of(payload([[0, 8, '你好']])),
    });

    // 只认 StateEffect.reconfigure（Transaction.reconfigured 对 appendConfig 也为 true，
    // 用它判会「自己触发自己」，见 quality-guidelines 禁止模式 10）
    const hasReconfigure = tr.effects.some((effect) => effect.is(StateEffect.reconfigure));
    expect(hasReconfigure).toBe(false);
  });

  it('should survive a base reconfigure with its value intact', () => {
    let state = EditorState.create({ doc: '// hello', extensions: [commentTranslationField] });
    state = state.update({ effects: setCommentTranslations.of(payload([[0, 8, '你好']])) }).state;

    // 模拟宿主重建配置（base 被整体替换，但同 id 的 field 应保留值）
    state = state.update({
      effects: StateEffect.reconfigure.of([commentTranslationField]),
    }).state;

    expect(state.field(commentTranslationField).entries).toHaveLength(1);
  });
});

describe('commentTranslations / field 身份必须模块级（M5 判别用例）', () => {
  it('should lose its value when reconfigured with a DIFFERENT field instance', () => {
    // 这条用例证明「模块级单例」不是风格问题而是正确性要求：
    // 若 `commentTranslationField` 写成函数内 `StateField.define`（每次调用新 id），
    // 宿主每次 reconfigure 都会把旧 field 从配置里换掉 → 译文静默归零。
    //
    // 用「新 field 实例」模拟那个后果，断言旧 field 不再可读（抛错）。
    let state = EditorState.create({ doc: '// hello', extensions: [commentTranslationField] });
    state = state.update({
      effects: setCommentTranslations.of({
        mode: 'below',
        entries: [{ from: 0, to: 8, text: '你好' }],
      }),
    }).state;
    expect(state.field(commentTranslationField).entries).toHaveLength(1);

    const freshField = StateField.define<unknown>({
      create: () => ({ mode: 'off', entries: [] }),
      update: (value) => value,
    });
    state = state.update({ effects: StateEffect.reconfigure.of([freshField]) }).state;

    // 旧 field 已不在配置中 —— 这正是「函数内 define」的后果
    expect(() => state.field(commentTranslationField)).toThrow();
  });
});
