import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { insertToSessionAgent } from '@/features/agent-chat/api/insertToSessionAgent';
import { insertToSessionTerminal } from '@/features/terminal';

import { setDragFile, useFileDrop } from '../useFileDrop';

/**
 * 投递一律经 terminal 域的**唯一编排**（决议 R1/Q1/Q5）：
 * Priority 1 = `insertToSessionAgent`（composer 优先，内部降级 Agent CLI），
 * Priority 2 = `insertToSessionTerminal`（同 session 前台终端）。
 */
vi.mock('@/features/agent-chat/api/insertToSessionAgent', () => ({
  insertToSessionAgent: vi.fn(),
}));
vi.mock('@/features/terminal', () => ({
  insertToSessionTerminal: vi.fn(),
}));

const mockAgent = vi.mocked(insertToSessionAgent);
const mockTerminal = vi.mocked(insertToSessionTerminal);

/** 让 agent 路径命中 / 不命中。 */
function agentHits(ok: boolean) {
  mockAgent.mockReturnValue(ok ? { ok: true } : { ok: false });
}

function dragEnd(path = '/some/path', projectId = 'proj-1') {
  act(() => {
    setDragFile(path, projectId);
  });
  act(() => {
    document.dispatchEvent(new Event('dragend'));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  agentHits(false);
  mockTerminal.mockReturnValue({ ok: false });
});

describe('useFileDrop · 双目标编排', () => {
  it('Priority 1 命中（composer / Agent CLI）→ 不再走终端分支', () => {
    agentHits(true);
    mount();
    dragEnd('/some/directory');

    expect(mockAgent).toHaveBeenCalledTimes(1);
    expect(mockTerminal).not.toHaveBeenCalled();
  });

  it('Priority 1 未命中 → 落 Priority 2（前台终端）', () => {
    mount();
    dragEnd('/some/file.txt');

    expect(mockAgent).toHaveBeenCalledTimes(1);
    expect(mockTerminal).toHaveBeenCalledTimes(1);
  });

  /**
   * **本任务连带 defect 的显式反证**（design §1.1）：旧实现用
   * `isTextInputElement(document.activeElement)` 判「是不是 agent 输入」，而 xterm 的
   * 输入载体本身就是 `<textarea class="xterm-helper-textarea">` ⇒ 终端聚焦时该判据
   * 恒为 true，文本被投给零监听者的 DOM 事件后丢弃，Priority 2 **在最主要场景下永不执行**。
   *
   * 现在仲裁只看身份，与焦点在哪个元素无关。
   */
  it('终端正被聚焦（xterm helper textarea）→ 终端分支仍然执行', () => {
    const termTextarea = document.createElement('textarea');
    termTextarea.className = 'xterm-helper-textarea';
    document.body.appendChild(termTextarea);
    termTextarea.focus();
    try {
      mount();
      dragEnd('/path/in/terminal');

      expect(mockAgent).toHaveBeenCalledTimes(1);
      expect(mockTerminal).toHaveBeenCalledTimes(1);
    } finally {
      termTextarea.remove();
    }
  });

  /** 任何其他输入框聚焦（commit message / LSP 配置）同样不再被当成 agent 目标。 */
  it('普通 textarea 聚焦 → 不劫持：仍按 agent → terminal 顺序仲裁', () => {
    const box = document.createElement('textarea');
    document.body.appendChild(box);
    box.focus();
    try {
      mount();
      dragEnd('/path');
      expect(mockAgent).toHaveBeenCalledTimes(1);
      expect(mockTerminal).toHaveBeenCalledTimes(1);
    } finally {
      box.remove();
    }
  });
});

describe('useFileDrop · 身份与文本形态', () => {
  it('两个目标都收到由 activeWorkspaceSession 派生的 session 身份（红线 12）', () => {
    mount();
    dragEnd('/some/path');

    expect(mockAgent).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', worktreePath: null }),
      '/some/path ',
    );
    expect(mockTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', worktreePath: null }),
      '/some/path ',
    );
    // 同一次拖拽两个分支必须用同一个 session 对象（不是各算一遍「等价键」）。
    expect(mockAgent.mock.calls[0][0]).toBe(mockTerminal.mock.calls[0][0]);
  });

  it('路径原样 + 一个尾空格：不加引号、不加尾斜杠、不补 \\r（可继续输入）', () => {
    mount();
    dragEnd('/dir/with space.txt');

    const text = mockAgent.mock.calls[0][1];
    expect(text).toBe('/dir/with space.txt ');
    expect(text.startsWith('"')).toBe(false);
    expect(text.endsWith('/')).toBe(false);
    expect(text.endsWith('\r')).toBe(false);
  });
});

describe('useFileDrop · pendingDrag 生命周期', () => {
  it('无 pendingDrag → 两个分支都不调用', () => {
    mount();
    act(() => {
      document.dispatchEvent(new Event('dragend'));
    });

    expect(mockAgent).not.toHaveBeenCalled();
    expect(mockTerminal).not.toHaveBeenCalled();
  });

  it('pendingDrag 单次消费：第二次 dragend 不重复投递', () => {
    mount();
    dragEnd('/dir/path');
    act(() => {
      document.dispatchEvent(new Event('dragend'));
    });

    expect(mockAgent).toHaveBeenCalledTimes(1);
    expect(mockTerminal).toHaveBeenCalledTimes(1);
  });

  it('卸载后不再响应 dragend（监听器已摘）', () => {
    const { unmount } = mount();
    unmount();
    act(() => {
      setDragFile('/after/unmount', 'proj-1');
      document.dispatchEvent(new Event('dragend'));
    });

    expect(mockAgent).not.toHaveBeenCalled();
  });
});

function mount() {
  return renderHook(() => useFileDrop());
}
