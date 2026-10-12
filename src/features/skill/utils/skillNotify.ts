import { useNotificationStore } from '@/shared/store/notificationStore';

/**
 * Skills 侧栏的通知出口（原为 SkillsPanel 内的 toast 回调）。
 * 类型 → 标题/级别的映射单一来源：错误统一 title=Error，其余 title=Skills。
 */
export function notifySkills(message: string, type: 'info' | 'error' = 'info'): void {
  useNotificationStore.getState().addNotification({
    type: type === 'error' ? 'error' : 'info',
    title: type === 'error' ? 'Error' : 'Skills',
    message,
  });
}
