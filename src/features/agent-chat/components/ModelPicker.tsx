import { ChevronDown, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ModelConfigOption, ModelInfo } from '@/features/agent/api/agentApi';
import { modelKeyOf, type ModelWritability } from '@/shared/utils/modelTarget';
import { noAutocorrectProps } from '@/ui/inputDefaults';

import { AgentBadge } from './AgentBadge';
import { displayName, providerLabelOf } from './constants';
import { ModelBadge } from './ModelBadge';
import { ModelConfigSection } from './ModelConfigSection';
import { ModelList } from './ModelList';

/** 不可写时的用户可见原因。措辞必须区分「等一下就好」与「一直如此」。 */
const MODEL_LIST_HINT: Record<ModelWritability, string | undefined> = {
  writable: undefined,
  loading: 'Models are loading…',
  'read-only': 'Read-only list for this agent',
};

/**
 * **空列表**时的文案 —— 按「为什么空」分三种，不能共用一句。
 *
 * - `loading`：会话正在建立，列表还没到（等一下就好）
 * - `read-only`：这个 agent 不提供模型选择（一直如此）
 * - `writable`：列表本应可写却空 —— 只能是真的没有模型
 *
 * 早期只有一句 `Models appear once the session is ready`，对 `read-only` 的
 * agent（如 deepseek）是误导：它永远不会出现。
 */
const MODEL_LIST_EMPTY: Record<ModelWritability | 'filtered', string> = {
  filtered: 'No matching models',
  loading: 'Models appear once the session is ready',
  'read-only': 'This agent offers no model selection',
  writable: 'No models available',
};

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
  writability = 'writable',
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
  /**
   * 模型列表的**可写性**（三态，而不是两个布尔）。
   *
   * - `'writable'` —— 可点，写回按 `modelWriteOf` 走
   * - `'loading'`  —— 会话建立中，暂时禁用（提示"等一下就好"）
   * - `'read-only'`—— 该 agent 无写通道，永久禁用（提示"只读"）
   *
   * 两个布尔能表达 4 种组合，其中 `{writable:true, pending:true}` 无意义 ——
   * 与 `ConfigCapability` 用枚举而非 bool 组合是同一个理由。
   *
   * 与 `disabled` 不同：`disabled` 是**此刻**不能操作（流式中），
   * 本项是**这份列表**能不能写。流式中仍允许展开浏览。
   */
  writability?: ModelWritability;
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

  // 打开下拉框时聚焦搜索框。
  //
  // `preventScroll: true` 不是可选优化 —— 缺了它，聚焦会把列表滚回顶部（搜索框
  // 在列表上方），把 `ModelList` 刚 `scrollIntoView` 到中间的选中项顶掉。表现就是
  // 「自动定位不生效」：滚动确实发生了，只是紧接着被聚焦撤销。
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => searchRef.current?.focus({ preventScroll: true }), 50);
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
  const displayNameLabel = current ? displayName(current.name) : 'Select model';
  // provider 是「同名模型散落在多个 provider 下」时唯一能分辨的信息，但只在该
  // 来源没把它拼进 `name` 时才单独显示（否则会重复）。判据收在 `providerLabelOf`。
  const providerLabel = current ? providerLabelOf(current) : undefined;

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
        {providerLabel ? <span className="param-provider">{providerLabel}</span> : null}
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
              selectedKey={current ? modelKeyOf(current) : undefined}
              onSelect={handleSelect}
              disabled={writability !== 'writable'}
              disabledHint={MODEL_LIST_HINT[writability]}
              emptyMessage={MODEL_LIST_EMPTY[models.length > 0 ? 'filtered' : writability]}
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
