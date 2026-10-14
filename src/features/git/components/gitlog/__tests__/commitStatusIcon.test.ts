// @vitest-environment node
import { isValidElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { FilePlus, FileText, Pencil, Trash2 } from '@/shared/components/icons';

import { commitStatusIcon } from '../commitStatusIcon';

/** 取元素的组件类型（icon 为 ReactNode，需收窄） */
function iconType(node: ReactNode): unknown {
  if (!isValidElement(node)) throw new Error('icon 不是合法 React 元素');
  return node.type;
}

function iconSize(node: ReactNode): unknown {
  if (!isValidElement(node)) throw new Error('icon 不是合法 React 元素');
  return (node.props as { size?: number }).size;
}

describe('commitStatusIcon', () => {
  it('M/A/D/R 映射到对应图标', () => {
    expect(iconType(commitStatusIcon('M', 10).icon)).toBe(Pencil);
    expect(iconType(commitStatusIcon('A', 10).icon)).toBe(FilePlus);
    expect(iconType(commitStatusIcon('D', 10).icon)).toBe(Trash2);
    expect(iconType(commitStatusIcon('R', 10).icon)).toBe(FileText);
  });

  it('颜色全部来自 --git-status-* 色板', () => {
    expect(commitStatusIcon('M', 10).color).toBe('text-git-status-modified');
    expect(commitStatusIcon('A', 10).color).toBe('text-git-status-added');
    expect(commitStatusIcon('D', 10).color).toBe('text-git-status-deleted');
    expect(commitStatusIcon('R', 10).color).toBe('text-git-status-modified');
  });

  it('图标携带传入的 size', () => {
    expect(iconSize(commitStatusIcon('M', 11).icon)).toBe(11);
    expect(iconSize(commitStatusIcon('M', 10).icon)).toBe(10);
  });

  it('未知 / undefined 字母回落到 M（modified）', () => {
    expect(iconType(commitStatusIcon(undefined, 10).icon)).toBe(Pencil);
    expect(commitStatusIcon(undefined, 10).color).toBe('text-git-status-modified');
    expect(iconType(commitStatusIcon('X', 10).icon)).toBe(Pencil);
    expect(commitStatusIcon('X', 10).color).toBe('text-git-status-modified');
  });
});
