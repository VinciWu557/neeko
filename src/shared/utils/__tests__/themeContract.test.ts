// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  CUSTOM_THEME_EXCLUDED,
  CUSTOM_THEME_OVERRIDABLE,
  THEME_VARIABLES,
  THEME_VARIABLE_GROUPS,
} from '@/shared/utils/themeVariables';

/**
 * 变量契约**自身**的完整性。
 *
 * 只测契约模块能自证的部分（非空 / 无重复 / 分组与展平一致 / 排除项合法）。
 * 「CSS 文件是否符合契约」由 `src/styles/__tests__/themeTokens.test.ts` 负责 ——
 * 那条测试需要读文件系统，属样式层，不属本模块的单元测试。
 *
 * ## 这个契约解决过什么
 *
 * 同一组变量名曾有三份独立清单且已漂移：
 *
 * | 位置 | 数量 |
 * | --- | --- |
 * | `styles/themes/*.css` 的 5 个主题 | 59 |
 * | `customThemeVars.ts` 的 `CUSTOM_CSS_VARS` | **31** |
 * | 测试里的校验清单 | 若干 |
 *
 * 实际后果：用户做自定义主题后 28 个变量无法覆盖 —— 包括全部 19 个 `--cm-*`
 * 语法色。编辑器语法高亮、终端前景色、Switch 轨道、弱分割线全部调不动，
 * 且界面没有任何提示。现在清单唯一来源是本模块。
 */
describe('theme variable contract', () => {
  it('is non-empty and has no duplicates', () => {
    // 健全性：防契约被误清空导致所有下游断言空转
    expect(THEME_VARIABLES.length).toBeGreaterThan(50);
    expect(new Set(THEME_VARIABLES).size).toBe(THEME_VARIABLES.length);
  });

  it('groups flatten to exactly THEME_VARIABLES', () => {
    // 分组只是可读性；展平结果必须与 THEME_VARIABLES 一致，
    // 否则「加变量只改了一处」的假设不成立。
    const flattened = Object.values(THEME_VARIABLE_GROUPS).flat();
    expect([...flattened].sort()).toEqual([...THEME_VARIABLES].sort());
  });

  it('every variable is a CSS custom property name', () => {
    // 契约的值会被拼进 `style.setProperty(...)`，拼错前缀会静默不生效。
    const malformed = THEME_VARIABLES.filter((v) => !/^--[a-zA-Z0-9-]+$/.test(v));
    expect(malformed).toEqual([]);
  });

  it('keeps the CodeMirror syntax palette complete', () => {
    // 这 19 个曾**全部**无法被自定义主题覆盖，是本次修复的核心缺陷。
    // 数量断言防「顺手删几个」把能力又缩回去。
    expect(THEME_VARIABLE_GROUPS.codeMirror).toHaveLength(19);
    const notOverridable = THEME_VARIABLE_GROUPS.codeMirror.filter(
      (v) => !CUSTOM_THEME_OVERRIDABLE.includes(v),
    );
    expect(notOverridable).toEqual([]);
  });
});

describe('custom theme override surface', () => {
  it('every excluded token exists in the contract', () => {
    // 排除项写错一个字母，就会变成「排除了一个不存在的变量」——
    // 既没起到排除作用，也没报错。
    const unknown = CUSTOM_THEME_EXCLUDED.filter((v) => !THEME_VARIABLES.includes(v));
    expect(unknown).toEqual([]);
  });

  it('excludes nothing today — shrinking this list is a deliberate decision', () => {
    // 这条断言是**有意的**：当前没有任何排除项。
    // 若将来有人往 CUSTOM_THEME_EXCLUDED 里加东西，这里会红 —— 强制在
    // 同一 PR 里重新审视「用户真的不该能调这个吗」。
    expect(CUSTOM_THEME_EXCLUDED).toEqual([]);
    expect(CUSTOM_THEME_OVERRIDABLE).toHaveLength(THEME_VARIABLES.length);
  });

  it('overridable list preserves contract order (no accidental reshuffle)', () => {
    // 顺序不影响正确性，但打乱会让 diff 噪音掩盖真实变更。
    const expected = THEME_VARIABLES.filter((v) => !CUSTOM_THEME_EXCLUDED.includes(v));
    expect(CUSTOM_THEME_OVERRIDABLE).toEqual(expected);
  });
});
