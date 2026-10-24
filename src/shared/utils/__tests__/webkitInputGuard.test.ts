import { afterEach, describe, expect, it } from 'vitest';

import { installWebKitInputGuard, isGhostText, stripGhostText } from '../webkitInputGuard';

/** jsdom 对 InputEvent 构造器的 inputType/data/isComposing 支持不完整，
 *  沿用 terminalInput.ts::createSyntheticInputEvent 的 defineProperties 兜底。 */
function fireBeforeInput(
  el: Element,
  data: string,
  opts: { composing?: boolean; inputType?: string } = {},
): boolean {
  const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true });
  Object.defineProperties(event, {
    inputType: { value: opts.inputType ?? 'insertText' },
    data: { value: data },
    isComposing: { value: opts.composing ?? false },
  });
  return el.dispatchEvent(event);
}

function fireKeyDown(el: Element, key: string, shift = false): boolean {
  return el.dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true }),
  );
}

describe('isGhostText', () => {
  it('判定方向键遗留码位 U+F700–U+F703 为幽灵字符', () => {
    expect(isGhostText('\uF700')).toBe(true);
    expect(isGhostText('\uF701')).toBe(true);
    expect(isGhostText('\uF702')).toBe(true);
    expect(isGhostText('\uF703')).toBe(true);
  });

  it('判定 C0 控制字符与 DEL 为幽灵字符', () => {
    expect(isGhostText('\u0000')).toBe(true);
    expect(isGhostText('\u0007')).toBe(true);
    expect(isGhostText('\u001C')).toBe(true);
    expect(isGhostText('\u007F')).toBe(true);
  });

  it('正常文本、CJK、\\t、\\n 不是幽灵字符（保留合法可输入字符）', () => {
    expect(isGhostText('~/.dsh/skills')).toBe(false);
    expect(isGhostText('中文abc')).toBe(false);
    expect(isGhostText('\t')).toBe(false);
    expect(isGhostText('\n')).toBe(false);
    expect(isGhostText('\r')).toBe(false);
  });
});

describe('stripGhostText', () => {
  it('剥离路径两侧的幽灵字符', () => {
    expect(stripGhostText('\uF702~/.dsh/skills\uF703\uF703\uF703')).toBe('~/.dsh/skills');
  });

  it('保留正常文本（含 \\t 与换行）', () => {
    expect(stripGhostText('a\tb\nc')).toBe('a\tb\nc');
    expect(stripGhostText('中文 dsh')).toBe('中文 dsh');
  });
});

describe('installWebKitInputGuard', () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
    document.body.innerHTML = '';
  });

  function makeInput(value = ''): HTMLInputElement {
    const el = document.createElement('input');
    el.value = value;
    document.body.appendChild(el);
    return el;
  }

  it('拦截方向键幽灵插入并恢复右移光标', () => {
    dispose = installWebKitInputGuard(document);
    const el = makeInput('ab');
    el.setSelectionRange(0, 0);

    fireKeyDown(el, 'ArrowRight');
    const notPrevented = fireBeforeInput(el, '\uF703');

    expect(notPrevented).toBe(false); // defaultPrevented
    expect(el.value).toBe('ab');
    expect(el.selectionStart).toBe(1);
    expect(el.selectionEnd).toBe(1);
  });

  it('左边界左移：阻止插入且光标不越界', () => {
    dispose = installWebKitInputGuard(document);
    const el = makeInput('ab');
    el.setSelectionRange(0, 0);

    fireKeyDown(el, 'ArrowLeft');
    const notPrevented = fireBeforeInput(el, '\uF702');

    expect(notPrevented).toBe(false);
    expect(el.value).toBe('ab');
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe(0);
  });

  it('shift + 右移恢复为扩选', () => {
    dispose = installWebKitInputGuard(document);
    const el = makeInput('ab');
    el.setSelectionRange(0, 0);

    fireKeyDown(el, 'ArrowRight', true);
    fireBeforeInput(el, '\uF703');

    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe(1);
  });

  it('多字符数据命中幽灵字符：阻止但不移动光标', () => {
    dispose = installWebKitInputGuard(document);
    const el = makeInput('ab');
    el.setSelectionRange(1, 1);

    const notPrevented = fireBeforeInput(el, 'x\uF703');

    expect(notPrevented).toBe(false);
    expect(el.selectionStart).toBe(1);
    expect(el.selectionEnd).toBe(1);
  });

  it('非方向键幽灵字符（如 U+F728 前向删除）：阻止但不移动光标', () => {
    dispose = installWebKitInputGuard(document);
    const el = makeInput('ab');
    el.setSelectionRange(1, 1);

    const notPrevented = fireBeforeInput(el, '\uF728');

    expect(notPrevented).toBe(false);
    expect(el.selectionStart).toBe(1);
    expect(el.selectionEnd).toBe(1);
  });

  it('IME 组合期间不拦截（marked text 交给输入法）', () => {
    dispose = installWebKitInputGuard(document);
    const el = makeInput('ab');

    const notPrevented = fireBeforeInput(el, '\uF703', { composing: true });

    expect(notPrevented).toBe(true);
  });

  it('insertCompositionText 类型不拦截', () => {
    dispose = installWebKitInputGuard(document);
    const el = makeInput('ab');

    const notPrevented = fireBeforeInput(el, '\uF703', { inputType: 'insertCompositionText' });

    expect(notPrevented).toBe(true);
  });

  it('正常文本插入不拦截', () => {
    dispose = installWebKitInputGuard(document);
    const el = makeInput('ab');

    expect(fireBeforeInput(el, 'x')).toBe(true);
    expect(fireBeforeInput(el, '~/.dsh/skills')).toBe(true);
  });

  it('非 input/textarea 目标（contenteditable）：只阻止插入，不抛错', () => {
    dispose = installWebKitInputGuard(document);
    const div = document.createElement('div');
    div.contentEditable = 'true';
    document.body.appendChild(div);

    expect(() => fireBeforeInput(div, '\uF703')).not.toThrow();
  });

  it('dispose 后不再拦截', () => {
    const teardown = installWebKitInputGuard(document);
    teardown();
    const el = makeInput('ab');

    expect(fireBeforeInput(el, '\uF703')).toBe(true);
  });
});
