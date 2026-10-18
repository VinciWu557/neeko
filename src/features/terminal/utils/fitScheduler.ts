/**
 * Resize 统一入口调度器：RAF 合帧 + 120ms trailing 兜底 + 已同步去重 + 失败 pending 重试
 * 四触发源（RO/attach/字体/session-ready）统一调用。
 *
 * **去重判据（根因不变式）**：只比对「该 PTY **已被通知**（已回执）或 **正在通知**（在途）
 * 的尺寸」，绝不比对「本次 fit 是否改变了本地网格」。
 *
 * ### 为何不能用 `converged` 作判据
 *
 * 原实现有一条早退闸：
 * ```
 * const converged = colsAfter === colsBefore && rowsAfter === rowsBefore;
 * if (converged && pendingCols === null) return;
 * ```
 * 它把「本地网格未变」当成了「无需通知 PTY」的理由，**在语义上是错的**：
 * fit 收敛只说明 xterm 本地网格没动，而被早退的是 **PTY 同步**。
 * tab 切回一个已 fit 过的终端时 fit 必然收敛 → PTY 永远收不到 resize →
 * agent / vim / htop 按旧网格重绘，表现为「格式混乱，拖一下 panel 才恢复」
 * （拖拽使本地网格真变，闸失效，才间接自愈）。→ **必须删除。**
 *
 * ### 但 `converged` 顺带承担了在途去重，不可一并丢弃
 *
 * 直接删掉整道闸会引入**第二类** bug：`scheduleFit` 同时挂 RAF 与 120ms trailing
 * 两个 doFit。RAF 那次发出 resize 后 promise 尚未回执，`lastCols` 仍为旧值 →
 * trailing 把同一个 resize 再发一次。而重复 resize 事件正是 `e9af28e4`
 * 专门修掉的格式混乱来源（频发于跨 WSL/SSH 的慢 resize IPC）。
 *
 * 正确做法是把两种状态分开建模，两个维度都要兼顾：
 * - `lastCols/Rows` —— 已**回执**的基线（成功时推进）；
 * - `inFlightCols/Rows` —— 已**发出未回执**的目标（发出时置位，settle 时清空）；
 * - `pendingCols/Rows` —— 发送**失败待重试**的目标（失败时置位，重发成功时清空）。
 *
 * 不变式（两条必须同时成立）：
 * 1. 新调度器实例的基线为空 → 首次 fit 必同步（tab 切回不丢 resize）；
 * 2. 尺寸命中「已回执」或「在途」→ 不得重发（不产生重复 resize 事件）。
 *
 * 历史教训：曾一度认为 `converged` “在语义上亦冗余、删掉即可”，
 * 该判断只看到了 1 而忽略了 2（见上方第二轮）。两者是两个正交不变量。
 */

export interface FitEntry {
  term: { cols: number; rows: number };
  fitAddon: { fit: () => void };
  sessionId: string | null;
}

export interface FitSchedulerDeps {
  getEntry: () => FitEntry | null;
  resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
}

/** 调度器实例句柄。`dispose` 由宿主在 cacheKey 切换 / 卸载时调用 —— 去重基线随实例生死重置。 */
export interface FitScheduler {
  scheduleFit: () => void;
  dispose: () => void;
  /** test-only introspection */
  _getState: () => {
    lastCols: number;
    lastRows: number;
    inFlightCols: number | null;
    inFlightRows: number | null;
    pendingCols: number | null;
    pendingRows: number | null;
  };
}

export function createFitScheduler(deps: FitSchedulerDeps) {
  let rafId: number | null = null;
  let trailingId: number | undefined;
  let lastCols = -1;
  let lastRows = -1;
  // 「已发出但未回执」的目标尺寸（在途去重）。与 lastCols/Rows 分工不同：
  // lastCols = 已确认送达 PTY 的基线；inFlight = 已发出、promise 未 settle。
  let inFlightCols: number | null = null;
  let inFlightRows: number | null = null;
  let pendingCols: number | null = null;
  let pendingRows: number | null = null;

  const doFit = () => {
    const c = deps.getEntry();
    if (!c) return;
    try {
      c.fitAddon.fit();
    } catch {
      return;
    }
    // 去重判据：该尺寸是否已被送达（lastCols）或已在途（inFlightCols）。
    // 任一命中都不得重发 —— 后者是移除 converged 闸后保留在途去重的关键。
    //（有 pending 待重试时必须重发，那是失败后的补偿路径。）
    const colsAfter = c.term.cols;
    const rowsAfter = c.term.rows;
    if (
      pendingCols === null &&
      ((colsAfter === lastCols && rowsAfter === lastRows) ||
        (colsAfter === inFlightCols && rowsAfter === inFlightRows))
    ) {
      return;
    }
    if (!c.sessionId) {
      pendingCols = colsAfter;
      pendingRows = rowsAfter;
      return;
    }
    const targetCols = colsAfter;
    const targetRows = rowsAfter;
    inFlightCols = targetCols;
    inFlightRows = targetRows;
    deps.resize(c.sessionId, targetCols, targetRows).then(
      () => {
        lastCols = targetCols;
        lastRows = targetRows;
        inFlightCols = null;
        inFlightRows = null;
        pendingCols = null;
        pendingRows = null;
      },
      () => {
        inFlightCols = null;
        inFlightRows = null;
        pendingCols = targetCols;
        pendingRows = targetRows;
      },
    );
  };

  const scheduleFit = () => {
    if (trailingId !== undefined) window.clearTimeout(trailingId);
    trailingId = window.setTimeout(() => {
      trailingId = undefined;
      doFit();
    }, 120);
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      doFit();
    });
  };

  const dispose = () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (trailingId !== undefined) window.clearTimeout(trailingId);
    rafId = null;
    trailingId = undefined;
  };

  return {
    scheduleFit,
    dispose,
    /** test-only introspection */
    _getState: () => ({ lastCols, lastRows, inFlightCols, inFlightRows, pendingCols, pendingRows }),
  };
}
