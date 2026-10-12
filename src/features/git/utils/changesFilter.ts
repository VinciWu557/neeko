import type { FileChange } from '@/shared/types';

/**
 * 变更列表「状态过滤」的单一来源。
 *
 * 可过滤词表从域类型派生（`FileChange['status']` 去掉只落在 unversioned 分组的 'Untracked'）：
 * 域新增状态时自动纳入，`STATUS_LABELS` 的 `Record` 会强制补映射（编译期报错），
 * 选项顺序即映射的声明顺序 —— 不再手写第二份词表数组。
 */
export type FilteredChangeStatus = Exclude<FileChange['status'], 'Untracked'>;
export type FilterStatus = 'all' | FilteredChangeStatus;

/** 过滤器 → 徽标文案（唯一映射；新增状态必须在此补齐，编译器强制）。 */
export const STATUS_LABELS: Record<FilterStatus, string> = {
  all: 'All',
  Modified: 'M',
  Added: 'A',
  Deleted: 'D',
  Renamed: 'R',
};

/** 过滤器选项（顺序 = 映射声明顺序；UI 直接遍历，不再硬编码数组）。 */
export const FILTER_STATUS_OPTIONS = Object.keys(STATUS_LABELS) as FilterStatus[];

/** 状态过滤：`'all'` 原样返回同一列表（不拷贝），否则取 `status` 精确匹配项。 */
export function filterChangesByStatus(files: FileChange[], status: FilterStatus): FileChange[] {
  return status === 'all' ? files : files.filter((f) => f.status === status);
}
