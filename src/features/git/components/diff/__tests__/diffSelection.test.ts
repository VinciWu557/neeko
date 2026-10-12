// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  computeSelectionRange,
  selectionKeys,
  mergeSelection,
  lastSelectedKeyOf,
} from '../diffSelection';

describe('computeSelectionRange', () => {
  it('should_normalize_downward_drag', () => {
    expect(computeSelectionRange({ hunk: 1, line: 3 }, { hunk: 0, line: 1 })).toEqual({
      start: { hunk: 0, line: 1 },
      end: { hunk: 1, line: 3 },
    });
  });

  it('should_keep_anchor_first_when_same_hunk_downward', () => {
    expect(computeSelectionRange({ hunk: 0, line: 1 }, { hunk: 0, line: 4 })).toEqual({
      start: { hunk: 0, line: 1 },
      end: { hunk: 0, line: 4 },
    });
  });

  it('should_swap_when_dragging_upward_in_same_hunk', () => {
    expect(computeSelectionRange({ hunk: 2, line: 5 }, { hunk: 2, line: 2 })).toEqual({
      start: { hunk: 2, line: 2 },
      end: { hunk: 2, line: 5 },
    });
  });
});

describe('selectionKeys', () => {
  // 三个 hunk，行数分别为 3 / 4 / 2
  const lineCounts = [3, 4, 2];

  it('should_build_keys_within_single_hunk', () => {
    const keys = selectionKeys({ hunk: 1, line: 1 }, { hunk: 1, line: 3 }, lineCounts);
    expect([...keys].sort()).toEqual(['1:1', '1:2', '1:3']);
  });

  it('should_include_full_middle_hunks_when_crossing', () => {
    const keys = selectionKeys({ hunk: 0, line: 1 }, { hunk: 2, line: 1 }, lineCounts);
    expect([...keys].sort()).toEqual(['0:1', '0:2', '1:0', '1:1', '1:2', '1:3', '2:0', '2:1']);
  });

  it('should_apply_prefix_for_combined_mode', () => {
    const keys = selectionKeys({ hunk: 0, line: 0 }, { hunk: 0, line: 1 }, lineCounts, 'src/a.ts');
    expect([...keys].sort()).toEqual(['src/a.ts\u00000:0', 'src/a.ts\u00000:1']);
  });
});

describe('mergeSelection', () => {
  it('should_replace_previous_selection', () => {
    const prev = new Set(['0:0', '0:1']);
    const next = mergeSelection(prev, new Set(['1:2', '1:3']), 'replace');
    expect([...next].sort()).toEqual(['1:2', '1:3']);
  });

  it('should_append_to_previous_selection', () => {
    const prev = new Set(['0:0', '0:1']);
    const next = mergeSelection(prev, new Set(['1:2']), 'append');
    expect([...next].sort()).toEqual(['0:0', '0:1', '1:2']);
  });

  it('should_not_mutate_input_set', () => {
    const prev = new Set(['0:0']);
    mergeSelection(prev, new Set(['1:0']), 'replace');
    expect(prev.has('0:0')).toBe(true);
  });
});

describe('lastSelectedKeyOf', () => {
  it('should_return_last_selected_line_key_across_hunks', () => {
    expect(lastSelectedKeyOf(new Set(['0:2', '1:0', '0:5']))).toBe('1:0');
  });

  it('should_return_last_line_within_same_hunk', () => {
    expect(lastSelectedKeyOf(new Set(['2:1', '2:4', '2:3']))).toBe('2:4');
  });

  it('should_return_null_for_empty_or_undefined_selection', () => {
    expect(lastSelectedKeyOf(new Set())).toBeNull();
    expect(lastSelectedKeyOf(undefined)).toBeNull();
  });
});
