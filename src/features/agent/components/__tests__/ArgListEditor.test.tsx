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
    // 判据覆盖**所有**渲染 `ArgListEditor` 的文件：CHAT 区拆出子组件后，
    // 只扫 `AgentForm.tsx` 会漏掉新位置（护栏会「绿着」但不再保护它们）。
    const src = ['AgentForm.tsx', 'ChatLaunchEditor.tsx']
      .map((f) => readFileSync(resolve(__dirname, '..', f), 'utf8'))
      .join('\n');

    // 只判**传给 ArgListEditor 的** `onChange`：那才是 memo 生效的前提。
    // `AgentForm` 里给非 memo 控件（如 Textarea）的内联箭头是合法的。
    const editorCalls = src.match(/<ArgListEditor[\s\S]*?\/>/g) ?? [];
    expect(editorCalls.length).toBeGreaterThanOrEqual(5);
    for (const call of editorCalls) {
      expect(call).not.toMatch(/onChange=\{\s*\(?\s*\(?next/);
    }
    expect(src).toContain('argSetters.');
    // placeholders 一律是模块常量或 useMemo 派生值。
    expect(src).not.toMatch(/placeholders=\{\[/);
  });

  /**
   * CHAT 区的两个 `React.memo` 子组件同理：`AgentForm` 必须传稳定回调。
   *
   * 变异验证：把 `onChange={chatSetters.chatEnabled}` 改回内联
   * `(next) => set(...)` → 本用例红。判据覆盖**传给 memo 组件的**回调 props
   * —— 子组件内部 DOM 控件的 onChange 不跨 memo 边界，不在此列。
   */
  it('AgentForm should pass stable callbacks to the memoised chat sections', () => {
    const src = readFileSync(resolve(__dirname, '../AgentForm.tsx'), 'utf8');
    const chatSectionCalls = [
      ...src.matchAll(/<(?:BuiltinChatSection|ChatLaunchEditor)[\s\S]*?\/>/g),
    ].map((m) => m[0]);
    expect(chatSectionCalls).toHaveLength(2);
    for (const call of chatSectionCalls) {
      expect(call).not.toMatch(/=\{\s*\(next/);
    }
    expect(src).toContain('chatSetters.');
  });
});
