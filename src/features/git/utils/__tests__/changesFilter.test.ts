// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createFileChange } from '@/testing/factories';

import { FILTER_STATUS_OPTIONS, filterChangesByStatus, STATUS_LABELS } from '../changesFilter';

/**
 * 词表与域类型的派生关系由类型系统兜底（`FilterStatus` 派生自 `FileChange['status']`，
 * `STATUS_LABELS` 的 `Record` 强制补齐新状态）；此处钉住运行时语义与 UI 顺序合同。
 */
describe('changesFilter', () => {
  const files = [
    createFileChange({ path: 'a.ts', status: 'Modified' }),
    createFileChange({ path: 'b.ts', status: 'Added' }),
    createFileChange({ path: 'c.ts', status: 'Modified' }),
    createFileChange({ path: 'd.ts', status: 'Renamed' }),
  ];

  it("'all' 原样返回同一列表（不拷贝）", () => {
    expect(filterChangesByStatus(files, 'all')).toBe(files);
  });

  it('按状态精确过滤，保留原顺序；无匹配返回空列表', () => {
    expect(filterChangesByStatus(files, 'Modified').map((f) => f.path)).toEqual(['a.ts', 'c.ts']);
    expect(filterChangesByStatus(files, 'Deleted')).toEqual([]);
  });

  it('选项 = 映射声明顺序（UI 徽标顺序合同）', () => {
    expect(FILTER_STATUS_OPTIONS).toEqual(['all', 'Modified', 'Added', 'Deleted', 'Renamed']);
    expect(FILTER_STATUS_OPTIONS.map((s) => STATUS_LABELS[s])).toEqual(['All', 'M', 'A', 'D', 'R']);
  });
});
