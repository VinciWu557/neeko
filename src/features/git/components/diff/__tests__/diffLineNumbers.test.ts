// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { maxLineNumDigits, lineNumColumnWidth } from '../diffLineNumbers';
import type { DiffHunk, DiffLine } from '../types';

describe('maxLineNumDigits', () => {
  function context(text: string): DiffLine {
    return { Context: text };
  }

  it('should_return_zero_for_empty_hunks', () => {
    expect(maxLineNumDigits([])).toBe(0);
  });

  it('should_return_1_for_single_digit_line_numbers', () => {
    const hunk: DiffHunk = {
      old_start: 1,
      old_lines: 2,
      new_start: 1,
      new_lines: 2,
      lines: [context('c1'), { Removed: 'old' }, { Added: 'new' }],
    };
    expect(maxLineNumDigits([hunk])).toBe(1);
  });

  it('should_count_digits_of_largest_rendered_line_number', () => {
    const hunk: DiffHunk = {
      old_start: 95,
      old_lines: 6,
      new_start: 95,
      new_lines: 6,
      lines: [
        context('c1'),
        context('c2'),
        context('c3'),
        context('c4'),
        context('c5'),
        context('c6'),
      ],
    };
    // 95..100 → 100 是 3 位
    expect(maxLineNumDigits([hunk])).toBe(3);
  });

  it('should_ignore_collapsed_placeholder_lines', () => {
    const hunk: DiffHunk = {
      old_start: 1,
      old_lines: 12,
      new_start: 1,
      new_lines: 12,
      lines: [
        context('c1'),
        context('c2'),
        context('c3'),
        { Collapsed: '4 unmodified lines' },
        context('c8'),
        context('c9'),
        context('c10'),
        { Removed: 'old' },
        { Added: 'new' },
      ],
    };
    // 折叠行不递增行号：渲染行号最大为 8（1 位）
    expect(maxLineNumDigits([hunk])).toBe(1);
  });

  it('should_track_old_and_new_numbers_independently', () => {
    const hunk: DiffHunk = {
      old_start: 1,
      old_lines: 3,
      new_start: 1,
      new_lines: 3,
      lines: [{ Removed: 'a' }, { Removed: 'b' }, { Added: 'x' }, { Added: 'y' }, context('c')],
    };
    // 连续删除/新增：old 与 new 各自独立递增，max = 3 → 1 位
    expect(maxLineNumDigits([hunk])).toBe(1);
  });

  it('should_take_max_across_multiple_hunks', () => {
    const h1: DiffHunk = {
      old_start: 1,
      old_lines: 1,
      new_start: 1,
      new_lines: 1,
      lines: [context('a')],
    };
    const h2: DiffHunk = {
      old_start: 100,
      old_lines: 1,
      new_start: 100,
      new_lines: 1,
      lines: [context('b')],
    };
    expect(maxLineNumDigits([h1, h2])).toBe(3);
  });
});

describe('lineNumColumnWidth', () => {
  it('should_build_width_from_max_digits', () => {
    const hunk: DiffHunk = {
      old_start: 95,
      old_lines: 6,
      new_start: 95,
      new_lines: 6,
      lines: [
        { Context: 'c1' },
        { Context: 'c2' },
        { Context: 'c3' },
        { Context: 'c4' },
        { Context: 'c5' },
        { Context: 'c6' },
      ],
    };
    // 100 为 3 位 → calc(3ch + 6px)
    expect(lineNumColumnWidth([hunk])).toBe('calc(3ch + 6px)');
  });

  it('should_fall_back_to_minimum_width_for_empty_hunks', () => {
    expect(lineNumColumnWidth([])).toBe('calc(1ch + 6px)');
  });
});
