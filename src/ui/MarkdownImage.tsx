import React, { useCallback, useMemo, useState } from 'react';

import { useAssetBasePath } from '@/shared/hooks/useAssetBasePath';
import { useAssetUrl } from '@/shared/hooks/useAssetUrl';

interface MarkdownImageProps {
  src?: string;
  alt?: string;
  /** 显式解析基准（md 文件目录 / skill 目录）；缺省回落当前Workspace根。 */
  basePath?: string;
}

/**
 * markdown 图片渲染（点击放大遮罩）。
 *
 * 解析走 `useAssetUrl`（唯一入口：本地 asset 协议 / 远程 IPC 字节通道 / 外链直通）
 * + `useAssetBasePath`（basePath 缺省回落当前Workspace根），
 * 因此 agent-chat / 会话消息 / PR 描述等「没有 md 文件语境」的渲染点
 * 不必各自传 basePath 也不会 404。
 */
export function MarkdownImage({ src, alt, basePath }: MarkdownImageProps) {
  const [overlay, setOverlay] = useState(false);
  // 错误态记「哪个 src 失败了」而不是布尔：流式消息里同一位置换 src 时，布尔会永久停在
  // 「Image failed to load」。派生比较既免了复位 effect，也免了级联渲染。
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const loadError = !!src && failedSrc === src;

  const resolvedBasePath = useAssetBasePath(basePath);
  const { url: resolvedSrc, loading } = useAssetUrl(src, resolvedBasePath);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOverlay(false);
  }, []);

  const isSvg = useMemo(() => {
    if (!src) return false;
    return src.endsWith('.svg') || src.startsWith('data:image/svg');
  }, [src]);

  if (!src) return null;

  if (loadError) {
    return (
      <span
        className="inline-block text-text-muted text-sm italic"
        title={`Failed to load: ${resolvedSrc}`}
      >
        {alt || 'Image failed to load'}
      </span>
    );
  }

  if (!resolvedSrc) {
    // 远程字节通道在飞：占位而不是闪一下破图；失败信息由 alt 兜底承担。
    if (loading) {
      return (
        <span className="inline-block animate-pulse bg-bg-tertiary rounded h-16 w-32 align-middle" />
      );
    }
    return (
      <span className="inline-block text-text-muted text-sm italic">
        {alt || 'Image unavailable'}
      </span>
    );
  }

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <img
        src={resolvedSrc}
        alt={alt || ''}
        className="max-w-full rounded cursor-pointer transition-opacity hover:opacity-80"
        style={isSvg ? { width: '100%' } : undefined}
        onClick={() => setOverlay(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOverlay(true);
          }
        }}
        onError={() => setFailedSrc(src ?? null)}
      />
      {overlay && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setOverlay(false)}
          onKeyDown={handleKeyDown}
          role="button"
          tabIndex={0}
          aria-label="Close image preview"
        >
          <img
            src={resolvedSrc}
            alt={alt || ''}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded"
          />
        </div>
      )}
    </>
  );
}
