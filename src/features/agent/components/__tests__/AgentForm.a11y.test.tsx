import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AgentForm from '../AgentForm';

/**
 * AgentForm 的输入控件必须**复用 `ui/Input`**，而不是裸写 `<input>`。
 *
 * # 为什么这是一条契约而不是风格偏好
 *
 * `ui/Input` 里封装了三件裸 `<input>` 不会自带的东西：
 *
 * 1. **IME 分词空格守卫**（`useImeSpaceGuard`）—— 中文输入法提交「拼音 候选」
 *    时会在值里留下空格；
 * 2. `noAutocorrectProps`（WebKit 的句首大写 / 自动纠错 / 拼写检查）；
 * 3. 统一的 focus ring 与 `disabled` 语义。
 *
 * 这个表单此前 8 个文本输入全是裸 `<input>`，等于把三件保护全丢了。判据只能是
 * 源码：裸 `<input>` 与 `<Input>` 的行为差异在单测里不可观测（都渲染出 textbox）。
 *
 * 变异验证：把任一处改回裸 `<input className={fieldCls}>` → 本用例红。
 */
describe('AgentForm reuses ui controls', () => {
  const source = readFileSync(resolve(__dirname, '../AgentForm.tsx'), 'utf8');

  it('should have no bare text inputs left', () => {
    // 允许的裸 `<input>` 只有 checkbox（不需要 IME / 自动大写 / focus ring）。
    const bareInputs = source.match(/<input[\s>]/g) ?? [];
    expect(bareInputs).toHaveLength(2);
    expect(source.match(/type="checkbox"/g) ?? []).toHaveLength(2);
  });

  it('should render text fields through Input and multiline through Textarea', () => {
    expect(source).toContain('<Input');
    expect(source).toContain('<Textarea');
    expect(source).toMatch(/from '@\/ui';/);
  });

  /** 文本域也走 `Textarea`，否则 CHAT Env 同样丢 IME 守卫。 */
  it('should not use a bare textarea', () => {
    expect(source).not.toMatch(/<textarea[\s>]/);
  });
});

/**
 * 可访问性：每个文本输入都必须有**关联**的 label。
 *
 * 用 `<label>` 包住自定义组件时，`jsx-a11y` 与读屏软件都无法把标签关联到控件
 * （静态分析看不到 `Input` 内部渲染的 `<input>`）。正确做法是 `label htmlFor`
 * + 控件 `id`。
 */
describe('AgentForm labels are associated', () => {
  it('should resolve every labelled text field by its label', () => {
    render(<AgentForm />);
    // 逐条按 label 文本取控件 —— getByLabelText 失败即说明关联断了。
    for (const label of [
      /^ID \*/,
      /^Name \*/,
      /^Command \*/,
      /^Skills Template/,
      /^Commands Template/,
      /^MCP Config Template/,
      /^Global Skill Path/,
      /^Install detection/,
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it('should give every labelled control a unique id', () => {
    render(<AgentForm />);
    // 8 个文本输入（CHAT Env 的 textarea 在无 CHAT 能力时不渲染）。
    const ids = screen.getAllByRole('textbox').map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(8);
  });
});
