import { ChevronDown } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { useEditorStore } from '@/shared/store/editorStore';
import type { AgentConfig } from '@/shared/types/agent';

import { AgentBadge } from './AgentBadge';
import { displayName } from './constants';

function ModelSelector({
  chatAgents,
  selectedAgent,
  tabKey,
  tabId,
}: {
  chatAgents: AgentConfig[];
  selectedAgent: { id: string; name: string; icon?: string | null };
  tabKey: string;
  tabId: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const positionDropdown = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const dropdown = btnRef.current
      .closest('.model-selector-wrap')
      ?.querySelector('.model-dropdown') as HTMLElement;
    if (dropdown) {
      dropdown.style.bottom = `${window.innerHeight - rect.top + 8}px`;
      dropdown.style.left = `${rect.left}px`;
    }
  }, []);

  return (
    <div className="model-selector-wrap">
      <button
        ref={btnRef}
        className={`model-selector-btn${open ? ' open' : ''}`}
        onClick={() => {
          setOpen(!open);
          if (!open) setTimeout(positionDropdown, 0);
        }}
      >
        <span className="model-icon">
          <AgentBadge icon={selectedAgent.icon} name={selectedAgent.name} id={selectedAgent.id} />
        </span>
        <span className="model-name">{displayName(selectedAgent.name)}</span>
        <span className="model-chevron">
          <ChevronDown size={12} />
        </span>
      </button>
      {open && (
        <>
          <div
            className="drop-overlay"
            role="button"
            tabIndex={0}
            aria-label="关闭下拉菜单"
            onClick={() => setOpen(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setOpen(false);
              }
            }}
          />
          {/*
            空态提示放在 listbox **外面**：`role="listbox"` 只允许 option / group
            子元素，塞一个文本 div 进去会被屏幕阅读器整段忽略。
          */}
          {chatAgents.length === 0 ? (
            <div className="attach-empty">暂无可用的 chat agent</div>
          ) : null}
          <div className="model-dropdown show" role="listbox" aria-label="Agents">
            {chatAgents.map((a) => {
              // 选中态同时要能被屏幕阅读器读到 —— 与 `ModelList` /
              // `ParamSelectors` 同一套语义（项目既有范式：`ActionPalette.tsx:94`）。
              const isSelected = a.id === selectedAgent.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`model-option${isSelected ? ' selected' : ''}`}
                  onClick={() => {
                    useEditorStore.getState().updateTab(tabKey, tabId, { agentId: a.id });
                    setOpen(false);
                  }}
                >
                  <AgentBadge icon={a.icon} name={a.name} id={a.id} />
                  <span className="model-opt-info">
                    <span className="model-opt-name">{displayName(a.name)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export { ModelSelector };
