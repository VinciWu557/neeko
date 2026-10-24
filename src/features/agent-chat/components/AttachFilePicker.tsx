import { File as FileIcon, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import type { FileNode } from '@/shared/types/file';

import { flattenFiles } from './paletteSources';

/**
 * 文件选择弹窗 —— 把项目文件树摊平成可选列表。
 *
 * # 为什么需要它
 *
 * 「附件」的整条链路（`attachments` state、chips 渲染、移除、随 prompt 发送）
 * 本来就在，但**没有任何选文件的入口**：`Attach files` 按钮只把文件树读进
 * 一个无人渲染的 state，点完什么都不会发生。本组件补的就是这一环。
 *
 * # 为什么是搜索框 + 扁平列表，而不是树
 *
 * 树要处理展开/折叠/键盘导航三套状态，而这里的目标是「快速找到某个文件」。
 * 扁平列表 + 子串过滤在文件多时反而更快，也更容易用键盘走完。
 */
interface AttachFilePickerProps {
  files: FileNode[];
  loading: boolean;
  /** 已附加的文件路径（避免重复添加，且按钮显示为禁用）。 */
  attached: string[];
  onPick: (file: FileNode) => void;
  onClose: () => void;
}

const AttachFilePicker: React.FC<AttachFilePickerProps> = ({
  files,
  loading,
  attached,
  onPick,
  onClose,
}) => {
  const [query, setQuery] = useState('');

  const all = useMemo(() => flattenFiles(files), [files]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 200);
    return all.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 200);
  }, [all, query]);

  return (
    <>
      <div
        className="drop-overlay"
        role="button"
        tabIndex={0}
        aria-label="关闭文件选择"
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <div className="attach-picker" role="dialog" aria-label="选择文件">
        <div className="attach-picker-head">
          <span className="attach-picker-title">
            选择文件{loading ? '（加载中…）' : `（${all.length}）`}
          </span>
          <button className="attach-picker-close" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>
        <input
          className="attach-picker-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by path…"
        />
        <div className="attach-picker-list scrollbar">
          {filtered.length === 0 && (
            <div className="attach-picker-empty">{loading ? 'Loading…' : 'No matching files'}</div>
          )}
          {filtered.map((file) => {
            const disabled = attached.includes(file.path);
            return (
              <button
                key={file.path}
                className="attach-picker-item"
                disabled={disabled}
                title={file.path}
                onClick={() => onPick(file)}
              >
                <span className="attach-picker-icon">
                  <FileIcon size={13} />
                </span>
                <span className="attach-picker-name">{file.name}</span>
                <span className="attach-picker-path">{disabled ? 'attached' : file.path}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
};

export default AttachFilePicker;
