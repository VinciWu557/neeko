import { ChevronDown, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ModelConfigOption, ModelInfo } from '@/features/agent/api/agentApi';
import { noAutocorrectProps } from '@/ui/inputDefaults';

import { AgentBadge } from './AgentBadge';
import { displayName } from './constants';
import { ModelBadge } from './ModelBadge';
import { ModelConfigSection } from './ModelConfigSection';

// ─── 模型搜索 Hook ───
// 高内聚：只负责搜索状态和过滤逻辑
// 低耦合：不依赖任何 UI 组件，可复用于任何需要模型搜索的场景
function useModelSearch(models: ModelInfo[]) {
  const [search, setSearch] = useState('');

  const filteredModels = useMemo(() => {
    if (!search.trim()) return models;
    const q = search.toLowerCase().trim();
    // 也匹配 `description`：Pi 把 provider 放在那里（它是列表里**唯一**能区分
    // 同名模型的信息 —— `deepseek-v4-pro` 会出现在 4 个 provider 下）。
    // 不匹配它，用户输入 provider 名时会看到「明明显示着却搜不到」。
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.group ?? '').toLowerCase().includes(q) ||
        (m.description ?? '').toLowerCase().includes(q),
    );
  }, [models, search]);

  const clearSearch = useCallback(() => setSearch(''), []);

  return { search, setSearch, filteredModels, clearSearch };
}

// ─── 模型搜索输入框 ───
// 高内聚：只负责搜索输入的 UI 渲染
// 低耦合：通过 props 接收状态和回调，不关心过滤逻辑
interface ModelSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  onEscape: () => void;
  inputRef?: React.Ref<HTMLInputElement>;
}

function ModelSearchInput({ value, onChange, onClear, onEscape, inputRef }: ModelSearchInputProps) {
  return (
    <div className="model-search-wrap">
      <Search size={14} className="model-search-icon" />
      <input
        ref={inputRef}
        type="text"
        className="model-search-input"
        placeholder="Search models..."
        value={value}
        maxLength={100}
        // WebKit 默认 `autocapitalize="sentences"` → 首字母被强制大写，
        // 用户输入 "deepseek" 得到 "Deepseek"。搜索是技术标识符匹配，
        // 必须关掉大写/纠错/拼写检查（与 ui/Input 同一常量）。
        {...noAutocorrectProps}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onEscape();
        }}
      />
      {value && (
        <button
          type="button"
          className="model-search-clear"
          onClick={onClear}
          aria-label="Clear search"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

// ─── 模型列表 ───
// 高内聚：只负责渲染模型列表
// 低耦合：通过 props 接收数据和回调，不关心搜索逻辑
interface ModelListProps {
  models: ModelInfo[];
  /** 选中项的**组合键**（`id|provider`）。不能用裸 id —— 同一 id 会出现在多个 provider 下。 */
  selectedKey: string | undefined;
  onSelect: (model: ModelInfo) => void;
  emptyMessage?: string;
}

function ModelList({
  models,
  selectedKey,
  onSelect,
  emptyMessage = 'No models available',
}: ModelListProps) {
  if (models.length === 0) {
    return <div className="attach-empty">{emptyMessage}</div>;
  }

  return (
    <>
      {models.map((m) => (
        <button
          key={`${m.id}|${m.group ?? ''}`}
          className={`param-option${selectedKey === `${m.id}|${m.group ?? ''}` ? ' selected' : ''}`}
          onClick={() => onSelect(m)}
        >
          <span className="param-opt-icon">
            <ModelBadge modelId={m.id} modelName={m.name} />
          </span>
          <span className="param-opt-info">
            <span className="param-opt-name">{displayName(m.name)}</span>
            {/*
              这里曾拼 `provider · 200k ctx · free`。三者都不是模型条目的属性：
              provider 已并入 `name`（解析实现如此），上下文大小与免费标记在 ACP 里
              是 `model_config` 配置项，规范要求渲染在模型选择器**附近**而不是挤进
              同一行文本。改由下方 config 区呈现。
            */}
            {(m.group ?? m.description) ? (
              <span className="param-opt-desc">{m.group ?? m.description}</span>
            ) : null}
          </span>
        </button>
      ))}
    </>
  );
}

// ─── 模型选择器（容器组件）───
// 高内聚：负责协调子组件，处理下拉框开关逻辑
// 低耦合：组合 useModelSearch + ModelSearchInput + ModelList
function ModelPicker({
  models,
  selected,
  onChange,
  agent,
  configOptions = [],
  onConfigChange,
  disabled,
}: {
  models: ModelInfo[];
  selected: ModelInfo | null;
  onChange: (model: ModelInfo) => void;
  /** 当前所选 agent（按钮与列表项图标展示）。 */
  agent: { id: string; name: string; icon?: string | null };
  /**
   * 模型相关配置项（`model_config` + `thought_level`）。
   *
   * 规范 SHOULD：渲染在模型选择器**附近**，因此放在同一个 popover 的下方，
   * 而不是拼进模型名那一行文本。
   */
  configOptions?: ModelConfigOption[];
  /** 配置项变更（下发 `session/set_config_option`）。 */
  onConfigChange?: (configId: string, value: string | boolean) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { search, setSearch, filteredModels, clearSearch } = useModelSearch(models);

  const positionDropdown = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const dropdown = btnRef.current
      .closest('.param-selector-wrap')
      ?.querySelector('.param-dropdown') as HTMLElement;
    if (dropdown) {
      dropdown.style.bottom = `${window.innerHeight - rect.top + 8}px`;
      dropdown.style.left = `${rect.left}px`;
    }
  }, []);

  // 打开下拉框时聚焦搜索框
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => searchRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [open]);

  const handleClose = useCallback(() => {
    setOpen(false);
    clearSearch();
  }, [clearSearch]);

  const handleSelect = useCallback(
    (model: ModelInfo) => {
      onChange(model);
      handleClose();
    },
    [onChange, handleClose],
  );

  const current = selected ?? null;
  const displayNameLabel = current
    ? displayName(current.name).length > 20
      ? `${displayName(current.name).slice(0, 18)}…`
      : displayName(current.name)
    : 'Select model';

  return (
    <div className="param-selector-wrap">
      <button
        ref={btnRef}
        className={`param-selector-btn model-picker-btn${open ? ' open' : ''}`}
        onClick={() => {
          if (!open) {
            setOpen(true);
            setTimeout(positionDropdown, 0);
          } else {
            handleClose();
          }
        }}
        title={current ? current.id : 'Select model'}
      >
        <span className="param-icon">
          {current ? (
            <ModelBadge modelId={current.id} modelName={current.name} />
          ) : (
            // 还没选模型（会话未建）→ 用 agent 图标，它此时是唯一有意义的身份
            <AgentBadge icon={agent.icon} name={agent.name} id={agent.id} />
          )}
        </span>
        <span className="param-name">{displayNameLabel}</span>
        <span className="param-chevron">
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
            onClick={handleClose}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleClose();
              }
            }}
          />
          <div className="param-dropdown show model-dropdown-scroll">
            <ModelSearchInput
              value={search}
              onChange={setSearch}
              onClear={clearSearch}
              onEscape={handleClose}
              inputRef={searchRef}
            />
            <ModelList
              models={filteredModels}
              selectedKey={current ? `${current.id}|${current.group ?? ''}` : undefined}
              onSelect={handleSelect}
              emptyMessage={
                models.length > 0
                  ? 'No matching models'
                  : // ACP 的模型列表只存在于会话内（协议没有独立的「列模型」方法），
                    // 会话在发送第一条消息时才建立。说「没有模型」是误导 —— 真相是
                    // 「还没有会话」。见 spec/backend/agent-acp-model-selection.md §7。
                    'Send a message first — models appear once a session exists'
              }
            />
            {/*
              模型相关配置项紧随模型列表：它们是「这个模型怎么跑」的参数，
              不是模型的属性。无配置项时 `ModelConfigSection` 自身返回 null。
            */}
            {onConfigChange ? (
              <ModelConfigSection
                options={configOptions}
                onChange={onConfigChange}
                disabled={disabled}
              />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

export { ModelPicker };
