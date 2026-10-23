import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import ArgListEditor from '../ArgListEditor';

/**
 * `ArgListEditor` —— argv 的保真编辑控件。
 *
 * 这些用例锁的是「一行一个参数」这个结构本身，因为方案 C 的正确性依赖于
 * 参数边界由**控件结构**承载，而不是靠文本解析恢复。
 */

function renderEditor(value: string[], onChange = vi.fn()) {
  const utils = render(
    <ArgListEditor value={value} onChange={onChange} placeholders={['program', 'arg']} />,
  );
  return { ...utils, onChange };
}

describe('ArgListEditor', () => {
  it('should render one input per argument', () => {
    renderEditor(['opencode', 'serve']);
    const inputs = screen.getAllByRole('textbox');
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toHaveValue('opencode');
    expect(inputs[1]).toHaveValue('serve');
  });

  it('should render only the add button when the list is empty', () => {
    renderEditor([]);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /add/i })).toBeInTheDocument();
  });

  /**
   * **核心保真用例**：编辑含空格的参数时，值原样进入数组。
   *
   * 旧实现把它压成一行，这次输入会被空格重新切分 —— 用户改一个字就把
   * `"hello world"` 变成两个参数。
   */
  it('should keep a value containing spaces in a single slot', async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor(['--sys', 'hello world']);

    const second = screen.getAllByRole('textbox')[1];
    expect(second).toHaveValue('hello world');

    await user.type(second, '!');
    // 每次都替换出完整数组：第二个参数仍是「一个」元素。
    expect(onChange).toHaveBeenLastCalledWith(['--sys', 'hello world!']);
  });

  it('should append an empty slot via the add button', async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor(['a']);

    await user.click(screen.getByRole('button', { name: /add/i }));
    expect(onChange).toHaveBeenCalledWith(['a', '']);
  });

  it('should remove the clicked argument only', async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor(['a', 'b', 'c']);

    await user.click(screen.getByRole('button', { name: 'Remove argument 2' }));
    expect(onChange).toHaveBeenCalledWith(['a', 'c']);
  });

  it('should not mutate the array it was given', async () => {
    const user = userEvent.setup();
    const original = ['a', 'b'];
    renderEditor(original);

    await user.click(screen.getByRole('button', { name: 'Remove argument 1' }));
    expect(original).toEqual(['a', 'b']);
  });

  it('should disable every control when disabled', () => {
    render(<ArgListEditor value={['a']} onChange={vi.fn()} disabled />);
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: /add/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove argument 1' })).toBeDisabled();
  });
});

/**
 * **IME 保护靠复用继承，不靠各自接线**。
 *
 * `ArgListEditor` 现在用 `ui/Input`，因此 IME 守卫、`noAutocorrectProps`、
 * focus 样式都由那一处提供 —— 保护的**行为**由 `ui/__tests__/Input.test.tsx`
 * 覆盖（含变异验证）。这里只锁「确实走的是那个组件」这一层，
 * 否则下一个人换回裸 `<input>` 时会静默丢掉保护。
 */
describe('ArgListEditor reuses ui/Input', () => {
  it('should render through ui/Input rather than a bare input', () => {
    const src = readFileSync(resolve(__dirname, '../ArgListEditor.tsx'), 'utf8');
    expect(src).toContain("from '@/ui'");
    expect(src).toContain('<Input');
    // 裸 <input 不得回潮（否则 IME 守卫与 WebKit 关断会再次丢失）。
    expect(src).not.toMatch(/<input[\s>]/);
  });
});

/**
 * `React.memo` 的**前提**：props 身份稳定。
 *
 * 注意不能靠「rerender 两次比 DOM 节点」来验证 —— `React.memo` 去掉后该断言
 * 依然通过（React 对相同元素类型会复用 DOM），那条测法是假护栏。
 *
 * 真正的失效点是**父组件传内联引用**：`onChange={() => …}` / `placeholders={[…]}`。
 * 所以判据只能落在源码上。
 */
describe('ArgListEditor memoisation preconditions', () => {
  it('AgentForm should pass stable props to every editor', () => {
    const src = readFileSync(resolve(__dirname, '../AgentForm.tsx'), 'utf8');
    // 回调来自模块/useMemo 派生的稳定对象，而不是内联箭头。
    expect(src).not.toMatch(/onChange=\{?\(?\s*\(?next/);
    expect(src).toContain('argSetters.');
    // placeholders 一律是模块常量或 useMemo 派生值。
    expect(src).not.toMatch(/placeholders=\{\[/);
  });
});
