// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  parseCollapsedCount,
  collapsedSectionRanges,
  spliceFullHunkSection,
  findFullHunkForOldLine,
} from '../diffCollapsedSections';
import type { DiffHunk, DiffLine } from '../types';

describe('parseCollapsedCount', () => {
  it('should_parse_plural_and_singular', () => {
    expect(parseCollapsedCount('12 unmodified lines')).toBe(12);
    expect(parseCollapsedCount('1 unmodified line')).toBe(1);
  });

  it('should_return_zero_for_unknown_text', () => {
    expect(parseCollapsedCount('random text')).toBe(0);
  });
});

describe('collapsedSectionRanges', () => {
  function context(text: string): DiffLine {
    return { Context: text };
  }

  function makeHunk(): DiffHunk {
    // old_start=1：前 3 行 context、折叠标记(4 行)、后 3 行 context、变更行
    return {
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
  }

  it('should_compute_hidden_old_and_new_ranges', () => {
    const ranges = collapsedSectionRanges(makeHunk());
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({
      index: 3,
      oldStart: 4,
      oldEnd: 7,
      newStart: 4,
      newEnd: 7,
    });
  });
});

describe('spliceFullHunkSection', () => {
  function context(text: string): DiffLine {
    return { Context: text };
  }

  it('should_extract_hidden_context_lines_from_full_hunk', () => {
    // 全量 hunk：包含被折叠的 4 行（c4-c7）
    const fullHunk: DiffHunk = {
      old_start: 1,
      old_lines: 12,
      new_start: 1,
      new_lines: 12,
      lines: [
        context('c1'),
        context('c2'),
        context('c3'),
        context('c4'),
        context('c5'),
        context('c6'),
        context('c7'),
        context('c8'),
        context('c9'),
        context('c10'),
        { Removed: 'old' },
        { Added: 'new' },
      ],
    };
    const spliced = spliceFullHunkSection(fullHunk, {
      index: 3,
      oldStart: 4,
      oldEnd: 7,
      newStart: 4,
      newEnd: 7,
    });
    expect(spliced.map((l) => l.Context)).toEqual(['c4', 'c5', 'c6', 'c7']);
  });
});

describe('findFullHunkForOldLine', () => {
  it('should_find_hunk_containing_old_line', () => {
    const h1: DiffHunk = { old_start: 1, old_lines: 10, new_start: 1, new_lines: 10, lines: [] };
    const h2: DiffHunk = { old_start: 20, old_lines: 5, new_start: 20, new_lines: 5, lines: [] };
    expect(findFullHunkForOldLine([h1, h2], 22)).toBe(h2);
    expect(findFullHunkForOldLine([h1, h2], 5)).toBe(h1);
  });

  it('should_return_null_when_not_found', () => {
    const h1: DiffHunk = { old_start: 1, old_lines: 10, new_start: 1, new_lines: 10, lines: [] };
    expect(findFullHunkForOldLine([h1], 99)).toBeNull();
  });
});
