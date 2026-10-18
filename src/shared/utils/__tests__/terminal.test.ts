import { afterEach, describe, it, expect, vi } from 'vitest';

import {
  buildFontFamily,
  buildTerminalOptions,
  buildTerminalTheme,
  DEFAULT_FONT_FAMILY,
  resolveTerminalType,
  TERMINAL_FONT_SIZE_FALLBACK,
  TERMINAL_SCROLLBACK,
} from '../../utils/terminal';
import {
  buildMonoStack,
  resolveTerminalLineHeight,
  TERMINAL_FONT_WEIGHT,
} from '../../utils/typography';

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

describe('buildFontFamily', () => {
  it('返回包含 monospace 和 Nerd Font fallback 的默认字体族', () => {
    expect(DEFAULT_FONT_FAMILY).toContain('monospace');
  });

  it('没有自定义字体时返回默认字体链 + Nerd Font fallback', () => {
    const result = buildFontFamily('');
    expect(result).toContain('monospace');
    expect(result).toContain('NerdFontSymbols');
    expect(result).toMatch(/NerdFontSymbols'$/);
  });

  it('有自定义字体时在前面添加，末尾仍有 Nerd Font fallback', () => {
    const result = buildFontFamily('Fira Code');
    expect(result).toMatch(/^'Fira Code'/);
    expect(result).toContain('monospace');
    expect(result).toContain('NerdFontSymbols');
  });
});

describe('buildTerminalTheme', () => {
  /** 让 cssVar() 从 `vars` 中取色，未命中返回空串（触发 fallback 分支）。 */
  function stubCssVars(vars: Record<string, string>) {
    vi.stubGlobal(
      'getComputedStyle',
      vi.fn(() => ({
        getPropertyValue: (name: string) => vars[name] ?? '',
      })),
    );
  }

  it('深色主题下滚动条 slider 使用 --bg-hover / --text-muted 主题色', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    stubCssVars({
      '--bg-secondary': '#1f1f1f',
      '--bg-hover': '#3e4451',
      '--text-muted': '#5c6370',
      '--accent-blue': '#61afef',
      '--terminal-selection': '#333333',
    });

    const theme = buildTerminalTheme();

    expect(theme.scrollbarSliderBackground).toBe('#3e4451');
    expect(theme.scrollbarSliderHoverBackground).toBe('#5c6370');
    expect(theme.scrollbarSliderActiveBackground).toBe('#5c6370');
    // 与 base.css 全局滚动条使用同一 token 源（--bg-hover thumb / --text-muted hover）
    expect(theme.background).toBe('#1f1f1f');
  });

  it('CSS 变量缺失时滚动条颜色回退到深/浅主题默认色', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    stubCssVars({});

    const darkTheme = buildTerminalTheme();
    expect(darkTheme.scrollbarSliderBackground).toBe('#3e4451');
    expect(darkTheme.scrollbarSliderHoverBackground).toBe('#5c6370');

    document.documentElement.setAttribute('data-theme', 'light');
    stubCssVars({});

    const lightTheme = buildTerminalTheme();
    expect(lightTheme.scrollbarSliderBackground).toBe('#c9cdd4');
    expect(lightTheme.scrollbarSliderHoverBackground).toBe('#9a9ea5');
  });

  it('写入 --terminal-* CSS 变量供 Debug Console 等面板同步', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    stubCssVars({ '--bg-secondary': '#101010' });

    buildTerminalTheme();

    const style = document.documentElement.style;
    expect(style.getPropertyValue('--terminal-bg')).toBe('#101010');
    expect(style.getPropertyValue('--terminal-fg')).not.toBe('');
  });
});

describe('buildTerminalOptions / resolveTerminalType', () => {
  function stubCssVarsEmpty() {
    vi.stubGlobal(
      'getComputedStyle',
      vi.fn(() => ({
        getPropertyValue: () => '',
      })),
    );
  }

  it('fontSize 未配置时回退到 TERMINAL_FONT_SIZE_FALLBACK（不再散落 ?? 14 字面量）', () => {
    stubCssVarsEmpty();
    const o = buildTerminalOptions({ terminalFontSize: null });
    expect(o.fontSize).toBe(TERMINAL_FONT_SIZE_FALLBACK);
  });

  it('fontSize 已配置时透传', () => {
    stubCssVarsEmpty();
    expect(buildTerminalOptions({ terminalFontSize: 16 }).fontSize).toBe(16);
  });

  it('lineHeight 由 resolveTerminalLineHeight(fontSize) 派生，与字体族同源', () => {
    stubCssVarsEmpty();
    const o = buildTerminalOptions({ terminalFontSize: 16 });
    expect(o.lineHeight).toBe(resolveTerminalLineHeight(16));
    expect(o.fontFamily).toBe(buildMonoStack(''));
  });

  it('mono 覆盖优先于通用 fontFamily', () => {
    stubCssVarsEmpty();
    const o = buildTerminalOptions({
      terminalFontSize: 14,
      monoFontFamily: 'JetBrains Mono',
      fontFamily: 'Some Other',
    });
    expect(o.fontFamily).toBe(buildMonoStack('JetBrains Mono'));
  });

  it('基线字段恒定：scrollback / fontWeight / allowProposedApi / theme', () => {
    stubCssVarsEmpty();
    const o = buildTerminalOptions({ terminalFontSize: 14 });
    expect(o.scrollback).toBe(TERMINAL_SCROLLBACK);
    expect(o.fontWeight).toBe(TERMINAL_FONT_WEIGHT);
    expect(o.allowProposedApi).toBe(true);
    // theme 走 buildTerminalTheme()（CSS 变量缺失时各字段为 undefined，但对象恒存在）
    expect(typeof o.theme).toBe('object');
    expect(o.theme).not.toBeNull();
  });

  it('默认开光标闪烁、不带 cursorStyle；只读视图显式关闭', () => {
    stubCssVarsEmpty();
    const interactive = buildTerminalOptions({ terminalFontSize: 14 });
    expect(interactive.cursorBlink).toBe(true);
    expect(interactive.cursorStyle).toBeUndefined();

    const readOnly = buildTerminalOptions({
      terminalFontSize: 14,
      cursorBlink: false,
      cursorStyle: 'underline',
      disableStdin: true,
      convertEol: true,
    });
    expect(readOnly.cursorBlink).toBe(false);
    expect(readOnly.cursorStyle).toBe('underline');
    expect(readOnly.disableStdin).toBe(true);
    expect(readOnly.convertEol).toBe(true);
  });

  it('未显式传 disableStdin / convertEol 时不写入字段（保持 xterm 默认）', () => {
    stubCssVarsEmpty();
    const o = buildTerminalOptions({ terminalFontSize: 14 });
    expect('disableStdin' in o).toBe(false);
    expect('convertEol' in o).toBe(false);
  });
});

describe('resolveTerminalType', () => {
  it('返回 fontSize + fontFamily 组合，fallback 与 buildTerminalOptions 一致', () => {
    const t = resolveTerminalType({ terminalFontSize: null, fontFamily: 'Fira Code' });
    expect(t.fontSize).toBe(TERMINAL_FONT_SIZE_FALLBACK);
    expect(t.fontFamily).toBe(buildMonoStack('Fira Code'));
  });
});
