import * as Dialog from '@radix-ui/react-dialog';
import {
  Info,
  CircleCheckBig,
  CircleAlert,
  CircleX,
  Copy,
  Check,
  ExternalLink,
} from 'lucide-react';
import { useCallback } from 'react';

import { useCopyToClipboard } from '@/shared/hooks/useCopyToClipboard';
import { useTransientFlag } from '@/shared/hooks/useTransientFlag';
import { useNotificationStore } from '@/shared/store/notificationStore';
import type { Notification, NotificationType } from '@/shared/store/notificationTypes';

import { reflowFromDeepLink } from '../reflow';

interface NotificationDetailProps {
  notification: Notification | null;
  onClose: () => void;
}

const typeIcons: Record<NotificationType, React.FC<{ size?: number; className?: string }>> = {
  info: (props) => <Info strokeWidth={2.5} {...props} />,
  success: (props) => <CircleCheckBig strokeWidth={2.5} {...props} />,
  warning: (props) => <CircleAlert strokeWidth={2.5} {...props} />,
  error: (props) => <CircleX strokeWidth={2.5} {...props} />,
};

const typeColors: Record<NotificationType, string> = {
  info: 'text-blue-400',
  success: 'text-status-idle',
  warning: 'text-yellow-400',
  error: 'text-destructive',
};

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function NotificationDetail({ notification, onClose }: NotificationDetailProps) {
  const { flag: copied, flash } = useTransientFlag(2000);
  const addNotification = useNotificationStore((s) => s.addNotification);
  const markAsRead = useNotificationStore((s) => s.markAsRead);
  const copyToClipboard = useCopyToClipboard();

  const handleCopy = useCallback(async () => {
    if (!notification) return;
    const ok = await copyToClipboard(
      `[${notification.title}]\n${notification.subtitle ? notification.subtitle + '\n' : ''}${notification.message}\n\n${formatDateTime(notification.timestamp)}`,
      'notification',
    );
    if (ok) {
      flash();
    } else {
      addNotification({
        type: 'error',
        title: 'Copy failed',
        message: 'Clipboard is not available. Please select and copy the text manually.',
      });
    }
  }, [notification, addNotification, copyToClipboard, flash]);

  /** 精确回流（D9）：复用既有 selectProject+activateTab 路径；找不到目标（会话已关）静默关闭。 */
  const handleOpenSession = useCallback(() => {
    if (!notification?.deepLink) return;
    markAsRead(notification.id);
    reflowFromDeepLink(notification.deepLink);
    onClose();
  }, [notification, markAsRead, onClose]);

  if (!notification) return null;

  return (
    <Dialog.Root
      open={!!notification}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-[9998]" />
        <Dialog.Content
          data-notification-detail
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-popover border border-border rounded-lg shadow-xl z-[9999] w-[400px] max-w-[90vw]"
        >
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <span className={typeColors[notification.type]}>
              {typeIcons[notification.type]({ size: 16 })}
            </span>
            <Dialog.Title className="text-sm font-medium text-text-primary flex-1">
              {notification.title}
            </Dialog.Title>
            <Dialog.Close className="text-text-muted hover:text-text-primary transition-colors">
              <span className="sr-only">Close</span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </Dialog.Close>
          </div>

          <div className="px-4 py-3">
            {notification.subtitle && (
              <p className="text-[11px] text-text-muted mb-2 truncate">{notification.subtitle}</p>
            )}
            <p className="text-xs text-text-primary whitespace-pre-wrap break-words leading-relaxed select-text">
              {notification.message}
            </p>
            <p className="text-[11px] text-text-muted mt-3">
              {formatDateTime(notification.timestamp)}
            </p>
          </div>

          <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
            {notification.deepLink && (
              <button
                type="button"
                onClick={handleOpenSession}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md bg-popover border border-border text-text-primary hover:bg-hover transition-colors cursor-pointer"
              >
                <ExternalLink size={12} />
                Open session
              </button>
            )}
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md bg-popover border border-border text-text-primary hover:bg-hover transition-colors cursor-pointer"
            >
              {copied ? (
                <>
                  <Check size={12} />
                  Copied
                </>
              ) : (
                <>
                  <Copy size={12} />
                  Copy
                </>
              )}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
