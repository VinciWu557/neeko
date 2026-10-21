import { ChevronDown, Circle, Clipboard, Flame, MinusCircle, Settings, Zap } from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';

import type { ModelConfigOption } from '@/features/agent/api/agentApi';

/**
 * 输入框工具条上的**会话配置项**选择器（模式 / 推理档位）。
 *
 * # 一条共同的设计约束
 *
 * 两个选择器的选项与当前值都来自 `configOptions`，**不来自前端常量**。
 * 旧实现把 `build/plan` 与 `low/medium/high/max` 写死在这里，`onChange` 只改
 * React state、从不发给后端 —— 用户以为切换了，agent 侧毫无变化。
 *
 * 调用方负责「没有该项就不渲染」（见 `modeOptionOf` / `thoughtLevelOptionOf`）：
 * 显示一个点不动的控件比不显示更糟。
 *
 * # 为什么两个选择器共用一个组件
 *
 * 它们除了图标映射外**逐行相同**（下拉定位、overlay、选中态、键盘关闭）。
 * 分成两份实现后，任何一处交互修复都要记得改两次 —— 这正是 DRY 的门槛
 * （重复第 3 次才抽象；这里是第 2 次且必然还会有更多 `category`）。
 */
interface ConfigOptionSelectorProps {
  option: ModelConfigOption;
  /** 当前值对应的图标（按值映射，未知值应返回中性图标）。 */
  iconFor: (value: string) => ReactNode;
  disabled?: boolean;
  onSelect: (configId: string, value: string) => void;
}

function ConfigOptionSelector({ option, iconFor, disabled, onSelect }: ConfigOptionSelectorProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

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

  const selected = typeof option.currentValue === 'string' ? option.currentValue : '';
  const current = option.options.find((o) => o.value === selected) ?? option.options[0];
  if (!current) return null;

  return (
    <div className="param-selector-wrap">
      <button
        ref={btnRef}
        className={`param-selector-btn${open ? ' open' : ''}`}
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
          if (!open) setTimeout(positionDropdown, 0);
        }}
      >
        <span className="param-icon">{iconFor(current.value)}</span>
        <span className="param-name">{current.name}</span>
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
            onClick={() => setOpen(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setOpen(false);
              }
            }}
          />
          <div className="param-dropdown show">
            {option.options.map((o) => (
              <button
                key={o.value}
                className={`param-option${o.value === selected ? ' selected' : ''}`}
                onClick={() => {
                  onSelect(option.id, o.value);
                  setOpen(false);
                }}
              >
                <span className="param-opt-icon">{iconFor(o.value)}</span>
                <span className="param-opt-info">
                  <span className="param-opt-name">{o.name}</span>
                  {o.description && <span className="param-opt-desc">{o.description}</span>}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 档位 → 图标。
 *
 * 按**已知档位名**映射，未知值退回中性图标 —— 让「新 agent 出现新档位名」
 * 只是少个图标，而不是崩掉渲染。
 */
function iconForLevel(value: string) {
  switch (value) {
    case 'minimal':
    case 'low':
      return <MinusCircle size={14} />;
    case 'high':
      return <Zap size={14} />;
    case 'max':
      return <Flame size={14} />;
    default:
      return <Circle size={14} />;
  }
}

/** 模式 → 图标（同样按已知值映射，未知值中性）。 */
function iconForMode(value: string) {
  switch (value) {
    case 'plan':
      return <Clipboard size={14} />;
    case 'build':
      return <Settings size={14} />;
    default:
      return <Circle size={14} />;
  }
}

/** 会话模式选择器（`category: "mode"`）。 */
export function AgentModeSelector(props: {
  option: ModelConfigOption;
  disabled?: boolean;
  onSelect: (configId: string, value: string) => void;
}) {
  return <ConfigOptionSelector {...props} iconFor={iconForMode} />;
}

/** 推理档位选择器（`category: "thought_level"`）。 */
export function ThinkingLevelSelector(props: {
  option: ModelConfigOption;
  disabled?: boolean;
  onSelect: (configId: string, value: string) => void;
}) {
  return <ConfigOptionSelector {...props} iconFor={iconForLevel} />;
}
