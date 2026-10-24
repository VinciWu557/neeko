import { useState } from 'react';

import type { ContextWindow } from './messageModel';

interface ContextWindowMeterProps {
  /** 用量展示模型（`meta` 事件派生，见 `contextWindowOf`）。 */
  contextWindow: ContextWindow;
}

/** 用量百分比（0–100，钳位）。limit 缺失时无意义，不调用。 */
function pctOf(used: number, limit: number): number {
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

/** 百分比展示：一位小数，整数值去小数（20.5% / 68%）。 */
function formatPct(pct: number): string {
  const text = pct.toFixed(1);
  return `${text.endsWith('.0') ? text.slice(0, -2) : text}%`;
}

/**
 * 万单位格式化：≥10000 → `万` 单位一位小数（`205000 → "20.5万"`，整万去小数
 * `100000 → "10万"`）；<10000 → 千分位原值（`9999 → "9,999"`）。
 */
export function formatWan(n: number): string {
  if (n >= 10_000) {
    const wan = n / 10_000;
    return `${Number.isInteger(wan) ? wan : wan.toFixed(1)}万`;
  }
  return n.toLocaleString('en-US');
}

/**
 * 上下文容量计量器 —— 纯环形按钮（无文字标签，环色分级传达状态，数值走
 * hover title）+ 点击弹出详情。
 *
 * 弹层：头部「上下文容量 + 已用/上限（百分比）」、横向用量进度条（>90% 红 /
 * >70% 黄 / 其余绿）、分割线 + 平均缓存命中率行。每一块只渲染有真实数据支撑
 * 的内容：无 `limit` 时只显已用量（无进度条、无百分比、无分级提示），无 cache
 * 计数时隐藏命中率行。
 */
export default function ContextWindowMeter({ contextWindow: win }: ContextWindowMeterProps) {
  const [open, setOpen] = useState(false);
  const { used, limit, model, cacheHitRate } = win;
  const pct = limit != null ? pctOf(used, limit) : null;
  const color =
    pct == null
      ? 'var(--accent-green)'
      : pct > 90
        ? 'var(--accent-red)'
        : pct > 70
          ? 'var(--accent-yellow)'
          : 'var(--accent-green)';
  const title =
    limit != null && pct != null
      ? `${formatPct(pct)} · ${formatWan(used)}/${formatWan(limit)} · ${model}`
      : `已用 ${formatWan(used)} · ${model}`;

  return (
    <div className="ctx-meter" title={title}>
      <button
        type="button"
        className="ctx-meter-btn"
        aria-label="查看上下文使用详情"
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 36 36" width="16" height="16">
          <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--border)" strokeWidth="4" />
          {pct != null && (
            <circle
              cx="18"
              cy="18"
              r="15.9"
              fill="none"
              stroke={color}
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={`${pct} ${100 - pct}`}
              strokeDashoffset="25"
            />
          )}
        </svg>
      </button>

      {open && (
        <>
          <div
            className="drop-overlay"
            role="button"
            tabIndex={0}
            aria-label="关闭上下文详情"
            onClick={() => setOpen(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setOpen(false);
              }
            }}
          />
          <div className="ctx-meter-pop" role="dialog" aria-label="上下文容量详情">
            <div className="ctx-pop-head">
              <span>上下文容量</span>
              <span className="ctx-pop-vals">
                {limit != null && pct != null
                  ? `${formatWan(used)}/${formatWan(limit)}（${formatPct(pct)}）`
                  : formatWan(used)}
              </span>
            </div>
            {limit != null && pct != null && (
              <div
                className="ctx-pop-bar"
                role="progressbar"
                aria-valuenow={used}
                aria-valuemin={0}
                aria-valuemax={limit}
              >
                <div className="ctx-pop-fill" style={{ width: `${pct}%`, background: color }} />
              </div>
            )}
            {cacheHitRate != null && (
              <>
                <div className="ctx-pop-divider" />
                <div className="ctx-pop-row">
                  <span>平均缓存命中率</span>
                  <span className="ctx-pop-val">{formatPct(cacheHitRate * 100)}</span>
                </div>
              </>
            )}
            {pct != null && (
              <div className="ctx-pop-foot">
                {pct > 90 ? (
                  <span style={{ color: 'var(--accent-red)' }}>接近上限，建议开启新会话</span>
                ) : pct > 70 ? (
                  <span style={{ color: 'var(--accent-yellow)' }}>用量偏高</span>
                ) : (
                  <span style={{ color: 'var(--accent-green)' }}>容量充足</span>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
