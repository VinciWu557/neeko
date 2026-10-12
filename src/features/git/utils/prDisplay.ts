/**
 * PullRequestsPanel 的展示层纯函数（从组件抽出：组件体积 ratchet / 纯逻辑可测）。
 */

export function formatCreatedAt(timestamp: string | undefined | null): string {
  if (!timestamp) return '';
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return timestamp;
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
  } catch {
    return timestamp || '';
  }
}

export function getStateBadgeClass(state: string): string {
  switch (state.toUpperCase()) {
    case 'OPEN':
      return 'bg-accent-green/15 text-accent-green';
    case 'CLOSED':
      return 'bg-accent-red/15 text-accent-red';
    case 'MERGED':
      return 'bg-[#a371f7]/20 text-[#a371f7]';
    default:
      return 'bg-bg-tertiary text-text-muted';
  }
}
