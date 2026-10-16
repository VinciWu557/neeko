import type { Extension } from '@codemirror/state';
import { EditorSelection } from '@codemirror/state';
import { EditorView, type MouseSelectionStyle } from '@codemirror/view';

/**
 * 单击坐标映射护栏（WKWebView + 大文件场景）。
 *
 * 症状：滚动（滚轮 / 滚动条）后单击，光标落在错误位置；此前还会出现
 * 「旧光标位置 → 点击位置」的幻影选区。上游 6.43.11 未修复。
 *
 * 真实根因（探针实证 2026-09-09）：**WebKit focus 滚动漂移**。拖滚动条使
 * 编辑器 blur 后点击，CM mousedown 顺序是 startMouseSelection →
 * focusPreventScroll（同步 focus）→ mouseSel.start()（dispatch 新
 * selection）。WebKit 下 focusPreventScroll 失效：focus 把视图滚到「旧
 * caret」所在位置 → scrollTop 漂移 → 映射（无论哪种）基于错误 scrollTop，
 * 光标落错。不是 `posAtCoords` 的 heightMap 失准（Chromium 探针 + 双实例
 * 期间 CM 原生 basicMouseSelection 一直工作正常均证伪该假设）。
 *
 * ⚠️ 爆炸半径（facets 的硬约束，改前必读）：
 * 本扩展注册在 `EditorView.mouseSelectionStyle` facet 上。CM 的 mousedown
 * handler 遍历该 facet、命中**第一个非 null** 的 style 即 break，命中后原生
 * `basicMouseSelection` 不会被调用。因此**只要本函数对某个手势返回非 null，
 * 它就必须自己实现该手势的全部选区语义**（拖选 / shift 扩选 / 多选区）——
 * basicMouseSelection 未从 @codemirror/view 导出，无法「委托给原生」。
 *
 * 收窄手段：只在 bug 的**唯一触发场景**接管，其余整体交还 CM 原生。该 bug
 * 仅当本次 mousedown 会触发一次 `focus()`（即编辑器当前未聚焦）时才发生；
 * 编辑器已聚焦 → 无 focus 事件 → 无漂移 → 直接返回 null。于是最常见路径
 * （从已聚焦编辑器拖选）走 CM 原生，本文件只服务于「未聚焦起手」的窄场景。
 *
 * 修复（两处，均在未聚焦接管分支内）：
 * 1. **焦点锚定**：CM focus 之前把 selection dispatch 到点击处，focus 滚动
 *    目标变成视口内的新 caret，不再漂移。
 * 2. **静止点击恢复 scrollTop**：get() 中若 scrollTop 与 mousedown 时偏差
 *    > 2px，恢复 mousedown 值再映射。mousedown 的 start() 首次调 get() 同步
 *    完成，视觉无闪。
 *
 * 接管分支内的选区三分支与 CM 原生逐行等价（映射走同一
 * `posAndSideAtCoords`，不引入自建命中测试层）：
 * - 静止点击（位移 < 阈值）：返回 cursor，杜绝幻影 range；
 * - 真实拖拽（位移 ≥ 阈值）：range(start, cur) 拖选语义（拖拽期间 scrollTop
 *   变化可能是用户拖出视口的 auto-scroll，属意图，不得恢复）；
 * - shift+click：`startSel.main.extend` 扩选。
 * - 双击 / 三击 / 非主键 / **编辑器已聚焦**：返回 null，回落 CM 内置
 *   basicMouseSelection。
 *
 * 若上游修复 focusPreventScroll（WebKit 侧），整个接管分支可删。
 */

/** Pointer movement below which a gesture is treated as a stationary click. */
const CLICK_MOVE_THRESHOLD_PX = 10;

interface MappedPoint {
  pos: number;
  assoc: -1 | 1;
}

/**
 * Map a viewport coordinate to a document position via CM's native
 * `posAndSideAtCoords`.
 */
function mapPoint(view: EditorView, x: number, y: number): MappedPoint {
  return view.posAndSideAtCoords({ x, y }, false);
}

export function makeMouseClickGuardStyle(
  view: EditorView,
  startEvent: MouseEvent,
): MouseSelectionStyle | null {
  if (startEvent.button !== 0) return null;
  if ((startEvent.detail || 1) !== 1) return null;

  // ── 激活门控（爆炸半径收窄）──────────────────────────────────────
  // 漂移 bug 只在「本次 mousedown 会触发 focus()」时存在，即编辑器当前未聚焦。
  // 已聚焦 → 无 focus 事件 → 无漂移 → 返回 null 让 CM 原生 basicMouseSelection
  // 接管整条手势（拖选 / shift / 多选区全量原生支持，零自定义代码）。
  // 常见路径（从已聚焦编辑器拖选）从此不再进入本文件。
  if (view.hasFocus) return null;

  const start = mapPoint(view, startEvent.clientX, startEvent.clientY);
  let startSel = view.state.selection;
  const startScrollTop = view.scrollDOM?.scrollTop ?? 0;

  // ── 焦点锚定（修复 WebKit focus 滚动漂移）────────────────────────────
  // 在 CM focus 之前把 selection dispatch 到点击处：caret 锚定在视口内的
  // 新位置，随后的 focus 滚动目标正确，scrollTop 不再漂移。
  const caret = EditorSelection.cursor(start.pos, start.assoc);
  try {
    if (typeof startSel.main.eq !== 'function' || !startSel.main.eq(caret)) {
      view.dispatch({ selection: caret, scrollIntoView: false });
    }
  } catch {
    // dispatch 失败不影响后续 mapping（兜底 CM 默认行为）
  }

  return {
    update(update) {
      if (update.docChanged) {
        start.pos = update.changes.mapPos(start.pos);
        startSel = startSel.map(update.changes);
      }
    },
    get(event, extend) {
      const moved =
        Math.abs(event.clientX - startEvent.clientX) + Math.abs(event.clientY - startEvent.clientY);
      // 静止点击：若 focus 滚动漂移了 scrollTop，先恢复 mousedown 值再映射。
      if (!extend && moved < CLICK_MOVE_THRESHOLD_PX) {
        const st = view.scrollDOM?.scrollTop;
        if (typeof st === 'number' && Math.abs(st - startScrollTop) > 2) {
          view.scrollDOM.scrollTop = startScrollTop;
        }
      }
      const cur = mapPoint(view, event.clientX, event.clientY);
      const clicked = EditorSelection.cursor(cur.pos, cur.assoc);
      if (extend) {
        return startSel.replaceRange(startSel.main.extend(clicked.from, clicked.to, cur.assoc));
      }
      if (moved < CLICK_MOVE_THRESHOLD_PX) {
        // Stationary click — never synthesize a phantom range.
        return EditorSelection.create([clicked]);
      }
      // Real drag — CM default semantics: anchor at mousedown, head at pointer.
      // （此分支与 CM 原生 basicMouseSelection 逐行等价，详见文件头爆炸半径说明）
      return EditorSelection.create([EditorSelection.range(start.pos, cur.pos, cur.assoc)]);
    },
  };
}

/** Install once in the CodeMirror extension list. */
export function mouseClickGuard(): Extension {
  return EditorView.mouseSelectionStyle.of(makeMouseClickGuardStyle);
}
