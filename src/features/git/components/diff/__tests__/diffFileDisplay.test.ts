// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  splitFilePath,
  fileBlockId,
  statusLetter,
  statusBadgeClass,
  sumFileStats,
  initialExpandedPaths,
  indexOfPath,
} from '../diffFileDisplay';
import type { CommitFileChange } from '../types';

function f(path: string): CommitFileChange {
  return { path, status: 'M', additions: 1, deletions: 0 };
}

describe('splitFilePath', () => {
  it('should_split_name_and_dir', () => {
    expect(splitFilePath('src/app/DockBarButton.tsx')).toEqual({
      name: 'DockBarButton.tsx',
      dir: 'src/app',
    });
  });
});

describe('fileBlockId', () => {
  it('should_sanitize_path_separators', () => {
    expect(fileBlockId('src/app/x.tsx')).toBe('fileblock-src_app_x.tsx');
  });
});

describe('statusLetter', () => {
  it('should_normalize_status_words_and_letters', () => {
    expect(statusLetter('modified')).toBe('M');
    expect(statusLetter('A')).toBe('A');
    expect(statusLetter('deleted')).toBe('D');
  });
});

describe('statusBadgeClass', () => {
  it('should_map_letter_to_badge_color', () => {
    expect(statusBadgeClass('A')).toBe('text-git-status-added bg-git-status-added/15');
    expect(statusBadgeClass('D')).toBe('text-git-status-deleted bg-git-status-deleted/15');
    expect(statusBadgeClass('R')).toBe('text-git-status-modified bg-git-status-modified/15');
  });

  it('should_default_unknown_letters_to_modified_color', () => {
    expect(statusBadgeClass('X')).toBe('text-git-status-modified bg-git-status-modified/15');
    expect(statusBadgeClass('M')).toBe('text-git-status-modified bg-git-status-modified/15');
  });
});

describe('sumFileStats', () => {
  it('should_sum_additions_and_deletions', () => {
    expect(
      sumFileStats([
        { path: 'a', status: 'M', additions: 3, deletions: 1 },
        { path: 'b', status: 'A', additions: 10, deletions: 0 },
      ]),
    ).toEqual({ additions: 13, deletions: 1 });
  });
});

describe('initialExpandedPaths', () => {
  it('should_expand_all_when_three_or_fewer', () => {
    const files = [f('a'), f('b'), f('c')];
    expect(initialExpandedPaths(files).size).toBe(3);
  });

  it('should_expand_only_preferred_when_many_files', () => {
    const files = [f('a'), f('b'), f('c'), f('d')];
    const set = initialExpandedPaths(files, 'c');
    expect([...set]).toEqual(['c']);
  });

  it('should_fallback_to_first_when_preferred_missing', () => {
    const files = [f('a'), f('b'), f('c'), f('d')];
    expect([...initialExpandedPaths(files, 'missing')]).toEqual(['a']);
  });
});

describe('indexOfPath', () => {
  it('should_return_index_or_minus_one', () => {
    const files = [f('a'), f('b')];
    expect(indexOfPath(files, 'b')).toBe(1);
    expect(indexOfPath(files, null)).toBe(-1);
  });
});
