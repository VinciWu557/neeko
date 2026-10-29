import type { FileTab } from '@/shared/types';
import { isImageFile } from '@/shared/utils/fileTree';

/**
 * 该 tab 是否可按**图片**预览。
 *
 * 环境不再参与判定：本地项目走 asset 协议直连，SSH/WSL 项目经 `read_file_bytes`
 * 二进制流 → blob URL（通道选择收在 `useAssetUrl`）。历史版本在这里按
 * `environment.type === 'Local'` 排除远程项目，代价是远程图片只能看
 * 「Binary file — cannot be displayed」。
 *
 * 判定只看两件事实：内容是二进制、扩展名是图片。
 */
export function useBinaryImagePreview(tab: FileTab): boolean {
  return tab.content.is_binary && isImageFile(tab.filePath);
}
