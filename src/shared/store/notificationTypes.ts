/**
 * in-app 通知的值类型与 store 契约 —— **本域类型的唯一落点**。
 *
 * 2026-10-13 合并：此前 `features/notification/notificationTypes.ts` 有一份逐字重复的副本，
 * 两份各被一半消费者使用 —— 加字段时漏改一份**不产生编译错误**（消费侧有、store 侧无 →
 * tsc exit 0），是静默漂移的温床。组件统一直导本文件（`@/shared/store/*` 是跨 feature 的
 * 约定式公开面，仓内 260+ 处同款先例）。
 */

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
  /** 系统通知回流地址（`neeko://{domain}/{instance_id}`；仅投递事件写入，用户操作不构造）。 */
  deepLink?: string;
  /** 会话主题（R7）：原生通知的第二行；应用内列表/详情同源展示。空串/缺省 = 无主题。 */
  subtitle?: string;
}

export interface NotificationStore {
  notifications: Notification[];
  unreadCount: number;
  addNotification: (data: Omit<Notification, 'id' | 'timestamp' | 'read'>) => string;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  removeNotification: (id: string) => void;
  clearAll: () => void;
}
