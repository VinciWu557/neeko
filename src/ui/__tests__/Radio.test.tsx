/**
 * `Radio` —— 原生 input + Tailwind 表达视觉的单选按钮。
 *
 * 这个组件是从 `src/styles/components/form.css`（14 行 CSS / 1 个顶层类）
 * 迁过来的。迁移的**理由不是样式写法**，而是分层：
 *
 * - 原 `.custom-radio` 只服务一个控件，不构成一个「组件域」，
 *   却占了 `components/` 一个文件位（判据见 `src/styles/README.md`）。
 * - 三处调用（`RemoteDialog` ×2、`RemoteAuthDialog` ×1）原本各自复制
 *   `<input> + <span className="radio-mark">` 结构。
 *
 * 本测试钉住两件事：
 * 1. **行为等价** —— 选中态 / 点击 / 禁用与原生 radio 一致（这是迁移不能改的）
 * 2. **可访问性** —— 能按 label 文字取到控件，且键盘聚焦有视觉反馈
 *    （原 CSS 用 `opacity: 0` 隐藏 input，聚焦时**没有任何提示**，属缺陷）
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RADIO_MARK_CLASS, Radio } from '../Radio';

describe('Radio —— 行为与原生 radio 等价', () => {
  it('渲染为 radio 角色，可按 label 文字取到', () => {
    render(
      <Radio name="auth" value="password" readOnly checked>
        Password
      </Radio>,
    );
    // 迁移前用 <label> 包裹 <input>，getByLabelText 能取到；
    // 迁移后结构不变，这条断言保证关联没断。
    expect(screen.getByRole('radio')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('受控选中态由 checked 驱动', () => {
    render(<Radio name="auth" value="key" readOnly checked />);
    expect(screen.getByRole('radio')).toBeChecked();
  });

  it('未选中时 unchecked', () => {
    render(<Radio name="auth" value="key" readOnly checked={false} />);
    expect(screen.getByRole('radio')).not.toBeChecked();
  });

  it('点击触发 onChange', async () => {
    const onChange = vi.fn();
    render(<Radio name="auth" value="key" onChange={onChange} checked={false} />);
    await userEvent.click(screen.getByRole('radio'));
    expect(onChange).toHaveBeenCalled();
  });

  it('禁用时不可交互', () => {
    render(<Radio name="auth" value="key" disabled checked={false} />);
    expect(screen.getByRole('radio')).toBeDisabled();
  });
});

describe('Radio —— 视觉状态由 peer / group 变体驱动', () => {
  // 视觉圆点是 aria-hidden 的纯装饰元素，DOM 查询会触发
  // testing-library/no-node-access；且这条契约本就不依赖渲染结果
  // （与 ui/Switch.tsx 同一手法：class 契约常量化后直接断言）。
  it('选中态与悬停态由 peer-checked / group-hover 表达', () => {
    // 选中：边框变 accent + 内部圆点放大
    expect(RADIO_MARK_CLASS).toContain('peer-checked:border-accent-blue');
    expect(RADIO_MARK_CLASS).toContain('peer-checked:after:scale-100');
    // 悬停：整个 label 可点，所以用 group-hover 而非 span 自身 hover
    expect(RADIO_MARK_CLASS).toContain('group-hover:border-accent-blue');
    // 未选中时圆点缩到 0
    expect(RADIO_MARK_CLASS).toContain('after:scale-0');
  });

  it('键盘聚焦有可见反馈（原 CSS 缺失，属可访问性修复）', () => {
    expect(RADIO_MARK_CLASS).toContain('peer-focus-visible:ring-2');
    expect(RADIO_MARK_CLASS).toContain('peer-focus-visible:ring-accent-blue');
  });

  it('颜色走语义 token，不写裸色值', () => {
    for (const token of ['border-border', 'bg-bg-tertiary', 'after:bg-accent-blue']) {
      expect(RADIO_MARK_CLASS).toContain(token);
    }
    expect(RADIO_MARK_CLASS).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(RADIO_MARK_CLASS).not.toMatch(/rgba?\(/);
  });

  it('输入框对读屏隐藏但可聚焦（sr-only 而非 display:none）', () => {
    render(
      <Radio name="auth" value="k" readOnly>
        Label
      </Radio>,
    );
    const input = screen.getByRole('radio');
    expect(input).toHaveClass('sr-only');
    // sr-only 保留可聚焦性；display:none / visibility:hidden 会让键盘无法到达
    expect(input).not.toHaveStyle({ display: 'none' });
  });
});
