/**
 * WKWebView「幽灵字符」输入守卫（macOS Tauri 宿主特有，原生 app 无此行为）。
 *
 * # 现象
 *
 * 中文 IME 激活时，原生 `input` / `textarea` 里按方向键，WebKit 偶尔把按键误经
 * `insertText:` 路径派发，将方向键的底层字符（遗留 macOS 功能键码位，私用区
 * U+F700–U+F703；偶见 C0 控制字符）当**文本插入**。这些码位在任何字体里都没有
 * 字形，渲染为豆腐块；且 `String.trim()` 不会剥离它们，随表单保存即污染落盘配置。
 *
 * # 修法（统一单点）
 *
 * `document` 捕获阶段一个 `beforeinput` 监听，全应用生效：共享 `ui/Input` /
 * `ui/Textarea`、散落的裸 `<input>`、composer textarea、xterm 的隐藏 textarea
 * 全部覆盖，无需逐组件打补丁。命中幽灵字符即 `preventDefault()`；若被吞掉的
 * 是方向键移动，用 `Selection.modify`（WebKit 私有 API，恰好本 bug 只在 WebKit
 * 发生）恢复光标行为；无该 API 时退回 `setSelectionRange` 的左右逐字符移动。
 *
 * CodeMirror 走 contenteditable 且自接管键盘，这里对它只做「阻止插入」的兜底。
 * 同族先例：`ime.ts`（拼音分词空格）、`terminalInput.ts`（Shift+符号 fallback）。
 */

/** 幽灵字符集：C0 控制字符（保留 \t \n \r —— 合法可输入）+ DEL + 遗留 Mac 功能键私用区。 */
const GHOST_TEXT_SOURCE = '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\uF700-\\uF7FF]';

/** 非全局实例用于 `test()`：全局正则的 `lastIndex` 有状态，复用会漏判。 */
const GHOST_TEXT_RE = new RegExp(GHOST_TEXT_SOURCE);
const GHOST_TEXT_STRIP_RE = new RegExp(GHOST_TEXT_SOURCE, 'g');

/** 方向键遗留码位 → 光标移动方向（line 为 true 时按行移动）。 */
const GHOST_ARROW_MOVE: ReadonlyMap<string, { forward: boolean; line: boolean }> = new Map([
  ['\uF700', { forward: false, line: true }], // ↑
  ['\uF701', { forward: true, line: true }], // ↓
  ['\uF702', { forward: false, line: false }], // ←
  ['\uF703', { forward: true, line: false }], // →
]);

/** keydown 与其触发的 beforeinput 之间的容许间隔（同帧派发，留出调度余量）。 */
const ARROW_KEY_WINDOW_MS = 100;

/** 判定数据是否含幽灵字符（键盘路径的插入永远不会合法包含这些码位）。 */
export function isGhostText(data: string): boolean {
  return GHOST_TEXT_RE.test(data);
}

/** 保存层兜底：剥离幽灵字符（粘贴等键盘守卫未覆盖路径的最后一道防线）。 */
export function stripGhostText(value: string): string {
  return value.replace(GHOST_TEXT_STRIP_RE, '');
}

function moveCaret(
  el: HTMLInputElement | HTMLTextAreaElement,
  move: { forward: boolean; line: boolean },
  shift: boolean,
): void {
  const selection = el.ownerDocument.defaultView?.getSelection();
  // WebKit 私有 API，与原生方向键行为完全一致（含 shift 扩选）。
  if (selection && typeof selection.modify === 'function') {
    selection.modify(
      shift ? 'extend' : 'move',
      move.forward ? 'forward' : 'backward',
      move.line ? 'line' : 'character',
    );
    return;
  }
  if (move.line) return; // 非 WebKit 回退不支持跨行；阻止插入已达成，放弃恢复
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  const head = move.forward ? Math.min(el.value.length, end + 1) : Math.max(0, start - 1);
  if (!shift) {
    el.setSelectionRange(head, head);
    return;
  }
  // 近似原生扩选：锚点留在原选区的起始（右移）/ 结束（左移）端。
  const anchor = move.forward ? start : end;
  el.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head));
}

/**
 * 安装全局幽灵字符守卫（app 生命周期内装一次，见 `app/bootstrap.ts`）。
 * 返回卸载函数，供测试隔离使用。
 */
export function installWebKitInputGuard(doc: Document): () => void {
  // beforeinput 紧随其触发的 keydown 派发：据此恢复 shift 扩选语义
  // （同 terminalInput.ts 追踪 shiftDown 的先例）。
  let lastArrow: { shift: boolean; at: number } | null = null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key.startsWith('Arrow')) {
      lastArrow = { shift: e.shiftKey, at: Date.now() };
    }
  };

  const onBeforeInput = (e: InputEvent) => {
    if (
      e.defaultPrevented ||
      e.isComposing ||
      e.inputType !== 'insertText' ||
      !e.data ||
      !isGhostText(e.data)
    ) {
      return;
    }
    e.preventDefault();
    const target = e.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) {
      return;
    }
    const move = e.data.length === 1 ? GHOST_ARROW_MOVE.get(e.data) : undefined;
    if (!move) return;
    const shift =
      lastArrow !== null && Date.now() - lastArrow.at <= ARROW_KEY_WINDOW_MS && lastArrow.shift;
    moveCaret(target, move, shift);
  };

  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('beforeinput', onBeforeInput, true);
  return () => {
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('beforeinput', onBeforeInput, true);
  };
}
