import { useEffect, useMemo, useState } from 'react';

import { readFileBytesAll } from '@/shared/api/fileBytes';
import { useProjectStore } from '@/shared/store/projectStore';
import { activeWorkspaceSession } from '@/shared/store/workspaceStore';
import { isRemoteAssetSrc, normalizeAssetPath, resolveAssetUrl } from '@/shared/utils/localAsset';
import type { ProjectId } from '@/shared/utils/workspaceRef';

export interface AssetUrlState {
  /** 可喂给 `<img src>` 的 URL；`null` = 尚不可用（加载中 / 无法解析 / 出错）。 */
  url: string | null;
  loading: boolean;
  error: string | null;
}

const IDLE: AssetUrlState = { url: null, loading: false, error: null };

interface Fetched {
  /** 请求标识；与当前 (project, basePath, src) 不一致即视为「过期结果」，不展示。 */
  key: string | null;
  url: string | null;
  error: string | null;
}

const NOT_FETCHED: Fetched = { key: null, url: null, error: null };

/**
 * 「资产 → 可渲染 URL」的**异步通道**（同步场景由 `resolveAssetUrl` 覆盖）。
 *
 * 通道选择由物理约束决定，不是偏好：
 * - **本地项目**：`convertFileSrc` 的 asset URL 直接喂 `<img>` —— 零 IPC、零拷贝；
 * - **SSH / WSL 项目**：asset 协议物理上够不着远程磁盘，只能经 IPC 取字节
 *   （`shared/api/fileBytes` 二进制流，红线 4）→ `URL.createObjectURL`；
 * - **http(s)/data:/blob:/asset:/协议相对**：本来就能直接渲染，原样返回。
 *
 * IPC 传的是「相对路径 + 基准目录」，由后端按目标环境语义拼接 —— 前端不拍平成绝对
 * 路径（见 `localAsset.ts` 模块注释）。
 *
 * blob URL 的生命周期归本 hook：卸载 / 换文件时 revoke —— 不回收会把整份字节
 * 一直留在 webview 进程里（图片预览反复开关即线性增长）。
 *
 * `loading` 是**派生**的（请求标识与当前入参不一致 ⇒ 在飞），不在 effect 里同步
 * `setState` —— 那会触发级联渲染，且让「切文件」出现一帧旧图。
 */
export function useAssetUrl(
  src: string | undefined,
  basePath?: string,
  projectId?: ProjectId | null,
): AssetUrlState {
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const pid = projectId ?? activeProjectId;
  const environmentType = useProjectStore(
    (s) => s.projects.find((p) => p.id === pid)?.environment.type,
  );

  const needsBytes = !!src && isRemoteAssetSrc(src);
  // 缺省（未选中项目）按本地处理：asset 协议是唯一不需要额外信息的通道。
  const isLocalProject = environmentType !== 'Wsl' && environmentType !== 'Remote';

  // 同步可得的 URL：外链 / data: / blob:，以及本地项目的 asset URL。
  const syncUrl = useMemo(() => {
    if (!src) return null;
    if (!needsBytes || isLocalProject) return resolveAssetUrl(src, basePath);
    return null;
  }, [src, basePath, needsBytes, isLocalProject]);

  const requestKey = `${pid ?? ''}\u0000${basePath ?? ''}\u0000${src ?? ''}`;
  const [fetched, setFetched] = useState<Fetched>(NOT_FETCHED);

  useEffect(() => {
    if (syncUrl !== null || !needsBytes || !pid) return;

    let cancelled = false;
    let objectUrl: string | null = null;

    readFileBytesAll(activeWorkspaceSession(pid), normalizeAssetPath(src ?? ''), {
      base: basePath,
    })
      .then((bytes) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([bytes]));
        setFetched({ key: requestKey, url: objectUrl, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setFetched({
          key: requestKey,
          url: null,
          error: e instanceof Error ? e.message : String(e),
        });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [syncUrl, needsBytes, pid, src, basePath, requestKey]);

  if (syncUrl !== null) return { url: syncUrl, loading: false, error: null };
  if (!needsBytes || !pid) return IDLE;

  const isCurrent = fetched.key === requestKey;
  return {
    url: isCurrent ? fetched.url : null,
    loading: !isCurrent,
    error: isCurrent ? fetched.error : null,
  };
}
