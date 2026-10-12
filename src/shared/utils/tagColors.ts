/**
 * Tag / tag-group chip colors using Neeko theme tokens only
 * (accent + surface vars from theme.css — no hard-coded Tailwind palette).
 *
 * 单一实现：此前 skill（`features/skill/components/skillTagColors.ts`）与 library
 * （`McpServerItems.tsx` 内联副本）各持一份 —— 调色板逐项一致但哈希算法不同，
 * 同一 tag 在两处会拿到不同颜色（抽样 15 个常见标签中 7 个漂移）。此处统一保留
 * skill 侧的模素哈希（`h*31 mod 1e9+7`，恒非负）：skill 侧视觉零变化，
 * library 侧向 canonical 对齐（颜色可能变化）。哈希映射由黄金值测试钉死。
 */
const TAG_PALETTE = [
  'bg-accent-blue/15 text-accent-blue',
  'bg-bg-selected text-text-secondary',
  'bg-accent-green/15 text-accent-green',
  'bg-accent-yellow/15 text-accent-yellow',
  'bg-bg-hover text-text-secondary',
  'bg-accent-blue/10 text-text-secondary',
  'bg-accent-red/12 text-accent-red',
  'bg-bg-tertiary text-text-muted',
  'bg-accent-green/10 text-text-secondary',
  'bg-accent-yellow/10 text-text-secondary',
] as const;

const TAG_GROUP_PALETTE = [
  'bg-accent-blue/15 text-accent-blue',
  'bg-accent-green/15 text-accent-green',
  'bg-bg-selected text-text-secondary',
  'bg-accent-yellow/15 text-accent-yellow',
  'bg-bg-hover text-text-secondary',
  'bg-accent-red/12 text-accent-red',
  'bg-bg-tertiary text-text-muted',
  'bg-accent-blue/10 text-text-secondary',
  'bg-accent-green/10 text-text-secondary',
  'bg-bg-selected text-text-muted',
] as const;

function hashTag(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) {
    h = (h * 31 + tag.charCodeAt(i)) % 1000000007;
  }
  return h;
}

export function tagChipClass(tag: string): string {
  return TAG_PALETTE[hashTag(tag) % TAG_PALETTE.length];
}

/** Badge colors for Tag Group labels on skill cards. */
export function tagGroupBadgeClass(name: string): string {
  return TAG_GROUP_PALETTE[hashTag(name) % TAG_GROUP_PALETTE.length];
}
