import React, { useCallback } from 'react';

import { cn } from '@/lib/utils';
import { Input } from '@/ui';

import { appendArg, removeArgAt, setArgAt } from './argList';

interface ArgListEditorProps {
  /** 当前 argv。 */
  value: readonly string[];
  /** 值变化时回调（总是新数组）。 */
  onChange: (next: string[]) => void;
  /** 每行输入框的占位符（按位置取，缺省用最后一个）。 */
  placeholders?: readonly string[];
  disabled?: boolean;
  /** 追加按钮的文案。 */
  addLabel?: string;
  className?: string;
  /** 输入框的附加类（仅在需要与周围区块区分底色时使用）。 */
  inputClassName?: string;
}

/**
 * 一个「参数一行一个输入框」的编辑器 —— argv 的**保真**编辑形态。
 *
 * # 为什么不是一行文本
 *
 * 单行文本承载不了参数边界：`['--sys', 'hello world']` 与 `['--sys','hello','world']`
 * 投影到同一行，反向解析必然丢失其中一种。这不是分词器够不够聪明的问题，而是
 * 载体不携带信息 —— 换任何库都只能减小损失。
 *
 * 一行一个参数时，边界由**控件结构**表达，不需要解析、不需要引号规则、不需要
 * 转义，往返天然无损。
 *
 * # 为什么抽成组件
 *
 * 五个字段共用同一语义（CLI `args` / CHAT 启动命令 / 三件套）。收在一处后
 * 增删改的交互只在一处定义，也不需要在每个字段上重复空槽位裁剪规则。
 */
const ArgListEditor: React.FC<ArgListEditorProps> = ({
  value,
  onChange,
  placeholders,
  disabled = false,
  addLabel = '+ Add',
  className,
  inputClassName,
}) => {
  const placeholderAt = useCallback(
    (index: number) => placeholders?.[Math.min(index, placeholders.length - 1)] ?? '',
    [placeholders],
  );

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {value.map((arg, index) => (
        // 索引即身份：参数天然有序且可重复，没有业务主键可用；每行绑定自己的
        // 值与回调，用索引不会造成受控输入错位。
        <div key={index} className="flex items-center gap-1">
          {/* 走 `ui/Input`：继承 IME 分词空格守卫与 WebKit 关断属性。
              argv 里的空格是**参数内容**，用户不会想到去清理一个自己没输入过的空格。 */}
          <Input
            size="sm"
            value={arg}
            disabled={disabled}
            onChange={(e) => onChange(setArgAt(value, index, e.target.value))}
            placeholder={placeholderAt(index)}
            className={cn(inputClassName, 'bg-bg-secondary')}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(removeArgAt(value, index))}
            className="shrink-0 px-1.5 py-0.5 rounded text-text-muted hover:text-accent-blue hover:bg-bg-hover disabled:opacity-40"
            title="Remove argument"
            aria-label={`Remove argument ${index + 1}`}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(appendArg(value))}
        className="self-start text-[0.72em] text-accent-blue hover:underline disabled:opacity-40"
      >
        {addLabel}
      </button>
    </div>
  );
};

export default React.memo(ArgListEditor);
