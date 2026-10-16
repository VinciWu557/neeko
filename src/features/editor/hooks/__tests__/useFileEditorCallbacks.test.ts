import type { EditorView } from '@codemirror/view';
import { renderHook, act } from '@testing-library/react';
import { createElement, type ReactNode, RefObject } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { FileActionsProvider } from '@/features/editor/FileActionsContext';

import { useFileEditorCallbacks } from '../useFileEditorCallbacks';

const writeTextMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));

vi.mock('@/shared/hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => writeTextMock,
}));

function makeView(): RefObject<EditorView | null> {
  return {
    current: {
      state: {
        selection: { main: { from: 7, to: 18, empty: false } },
        sliceDoc: (from: number, to: number) => 'hello world'.slice(from - 7, to - 7),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试替身只覆盖被测路径
    } as any,
  };
}

const STUB_ACTIONS = {
  onFileSelect: vi.fn(async () => true),
  onFileRefresh: vi.fn(),
  onFileCloseTab: vi.fn(),
  onFileActivateTab: vi.fn(),
  onFileSave: vi.fn(async () => true),
  onFileSaveTab: vi.fn(async () => true),
  onFileContentChange: vi.fn(),
  onLoadFileTree: vi.fn(),
  onExpandDir: vi.fn(async () => {}),
};

function renderCallbacks(editorViewRef: RefObject<EditorView | null>) {
  return renderHook(() => useFileEditorCallbacks({ editorViewRef }), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(FileActionsProvider, { value: STUB_ACTIONS }, children),
  });
}

describe('useFileEditorCallbacks — 选中文本复制（单一真值：view.state）', () => {
  beforeEach(() => {
    writeTextMock.mockClear();
  });

  it('复制当前选区文本到剪贴板', () => {
    const { result } = renderCallbacks(makeView());

    act(() => {
      result.current.handleCopySelection();
    });

    expect(writeTextMock).toHaveBeenCalledWith('hello world');
  });

  it('无编辑器视图时不调用复制', () => {
    const { result } = renderCallbacks({ current: null });

    act(() => {
      result.current.handleCopySelection();
    });

    expect(writeTextMock).not.toHaveBeenCalled();
  });

  it('空选区（from === to）不调用复制', () => {
    const editorViewRef: RefObject<EditorView | null> = {
      current: {
        state: {
          selection: { main: { from: 3, to: 3, empty: true } },
          sliceDoc: vi.fn(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试替身只覆盖被测路径
      } as any,
    };
    const { result } = renderCallbacks(editorViewRef);

    act(() => {
      result.current.handleCopySelection();
    });

    expect(writeTextMock).not.toHaveBeenCalled();
  });
});
