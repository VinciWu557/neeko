/**
 * 系统通知投递事件的前端监听器：写 in-app 通知列表（badge/列表由既有
 * NotificationButton/NotificationList 链路展示）。
 *
 * 与后端 `notification/dispatch.rs` 的投递一一对应：原生通知由 OS 负责展示，
 * 本监听负责应用内记录（design R3.2 回流链路的应用内半边 —— 点击原生通知
 * 由系统默认把应用带到前台，列表可导航到对应会话）。
 */

import { useCallback } from 'react';

import { NOTIFICATION_DELIVERED_EVENT } from '@/shared/events';
import { useTauriEvent } from '@/shared/hooks/useTauriEvent';
import { useNotificationStore } from '@/shared/store/notificationStore';
import type { NotificationDraft } from '@/shared/types/notification';

/** 语义类别 → in-app 通知类型映射（in-app 三语义 → 既有四级的数据映射，无逻辑分支膨胀）。 */
const CLASS_TO_TOAST_TYPE: Record<NotificationDraft['class'], 'warning' | 'success' | 'error'> = {
  action_required: 'warning',
  completed: 'success',
  failed: 'error',
};

export function useNotificationDelivered(): void {
  const handleDelivered = useCallback((draft: NotificationDraft) => {
    useNotificationStore.getState().addNotification({
      type: CLASS_TO_TOAST_TYPE[draft.class] ?? 'info',
      title: draft.title,
      message: draft.body,
      deepLink: draft.deep_link,
      // 空串主题不入库：缺省与空串在渲染层是同一语义（无第二行），不制造两种「无」。
      subtitle: draft.subtitle || undefined,
    });
  }, []);
  useTauriEvent<NotificationDraft>(NOTIFICATION_DELIVERED_EVENT, handleDelivered);
}
