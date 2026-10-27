/**
 * ESLint 规则：`ui/accent-foreground`
 *
 * 判据：**压在实底 accent 上的元素，其前景色必须是 accent 底上的前景色。**
 *
 * ## 为什么需要这条规则
 *
 * 2026-10-27 连续三轮「UI 精致化」返工都是同一个错误的变体：
 * 把某个元素改成「跟随主题」的颜色时，只想了「它是文字」，
 * 忘了「它压在什么底上」——
 *
 * | 位置 | 错误写法 | 后果 |
 * | --- | --- | --- |
 * | `ui/Switch.tsx` 滑块 | `bg-text-primary` | Claude 主题：深棕滑块压赭红轨道，对比 1.41 |
 * | `WelcomeScreen.tsx` 主按钮 | `text-text-primary` | dark 1.37 / one-dark-pro 1.11 |
 * * `GitDialog.tsx` 自制 switch 滑块 | `bg-text-secondary` | dark 1.19 |
 * | `agent.css` `.agent-bar-btn.selected` | `color: var(--text-primary)` | one-dark-pro 1.11 |
 *
 * 根因不是「用了错 token」，而是**没问「它压在什么底上」**：
 * accent 实底上的前景色是 `--text-on-accent`（accent 底上的前景色），
 * 不是 `--text-primary`（页面文字色）。
 * 这两个值在暗色主题下差得极远（近白 vs 近黑）。
 *
 * ## 判据的三个边界（决定误报率）
 *
 * 1. **只认「实底」**：`bg-accent-blue` 算实底；`bg-accent-blue/15` **不算** ——
 *    半透明底是「海面 + 淡 accent」，上面用普通文字色是**对的**。
 * 2. **同元素不算违规**：`<button class="bg-accent-blue text-text-primary">` 里
 *    文字色写错了 → 违规；但 `<span class="bg-accent-blue">` 自身没有文字色 → 不违规。
 * 3. **只看 className 里的颜色类**：`text-xs` / `text-sm` 是**字号**不是颜色，不参与判据。
 *
 * ## 为什么用 eslint 而不是护栏（正则扫描）
 *
 * 正则扫描实测**误报 21 处**（两轮才收敛）：
 * - `\b` 边界把 `bg-accent-blue/15` 算成实底 → 16 处误报
 * - `text-xs` / `text-sm` 当成颜色 → 5 处误报
 *
 * eslint 有 AST，能正确区分「实底 / 半透明」「字号 / 颜色」，
 * 也能顺着 JSX 树找到「压在实底上的子元素」。
 *
 * ## 允许的前景色
 *
 * - `text-text-on-accent`（Neeko 语义 token）
 * - `text-[var(--text-on-accent)]`（同上的任意值写法）
 * - `text-destructive-foreground` / `text-primary-foreground`（shadcn 语义 token）
 * - `text-white`（过渡期允许；本仓已清零，保留以免误伤存量）
 */

'use strict';

/**
 * 实底 accent：**无前缀**的 `bg-accent-*` / `bg-destructive`，且**不带透明度后缀**。
 *
 * 「无前缀」是硬要求 —— 以下都不是「accent 实底」，不得判违规：
 *
 * | 写法 | 实际含义 | 为什么不能当实底 |
 * | --- | --- | --- |
 * | `hover:border-accent-blue` | hover 时**边框**变蓝 | 是 border 不是 bg |
 * | `border-l-accent-green` | **左边框**颜色 | 是 border 不是 bg |
 * | `data-[state=on]:bg-accent-blue` | **状态变体** | 与 `data-[state=on]:text-...` 互斥，不是「底+前景」 |
 * | `focus:border-accent-blue` | focus 时边框变蓝 | 是 border 不是 bg |
 * | `bg-accent-red/10` | **半透明**底 | 是「海面 + 淡 accent」，普通文字色才对 |
 *
 * 最后一条最关键：`bg-accent-red/10 text-accent-red`（淡红底 + 红字）是
 * **常见且正确**的设计（错误提示框），若当实底判 → 误报。
 */
const SOLID_ACCENT =
  /^(?:bg-(?:accent-(?:blue|red|green|yellow|orange|brick)|destructive))$/;

/**
 * accent 底上的合法前景色。
 *
 * 允许**透明度后缀**（`text-text-on-accent/80`）—— 选中项里的次级文字
 * （命令、路径）常用 80% 保留层级感，这是本仓既定写法，不是错误。
 */
const ON_ACCENT_FOREGROUND =
  /^(?:text-text-on-accent|text-\[var\(--text-on-accent\)\]|text-destructive-foreground|text-primary-foreground|text-white)(?:\/\d+)?$/;

/**
 * Tailwind / 本仓字体阶梯的**字号类**（唯一来源）。
 *
 * 清单来源：`src/styles/tokens/tailwind.css` 的 `--text-*` 与 Tailwind 内建档位。
 * 新增字体阶梯 token 时**只需改这一处** —— 判据里所有「这是不是颜色」的提问
 * 都从这里派生（见 `isForegroundToken`）。
 *
 * 历史教训：曾同时存在一份「负向断言排字号」的正则和这份正向枚举，
 * 两份内容不一致（负向那份没有 `text-micro` / `text-ui` 等本仓阶梯名）。
 * 当时行为正确纯属侥幸 —— 正向那份兜住了。改一处漏一处就会静默误报。
 */
const FONT_SIZE_CLASS =
  /^(?:text-(?:xs|sm|base|lg|[2-5]xl|micro|meta|ui|ui-md|ui-lg|section))$/;

/**
 * 一个 class token 是否是**前景色**（而不是字号 / 任意值 / 非 text- 类）。
 *
 * 判据集中在这里，避免「哪些 text-* 算颜色」的知识散落多处：
 * - `text-xs` / `text-ui` … → 字号，不是颜色
 * - `text-[var(--x)]` → 任意值，无法静态判定，宁漏不误报
 * - `text-text-on-accent/80` → 是颜色（含透明度后缀，字符集必须含 `/`）
 *
 * 字符集含 `/` 是必需的：`text-text-on-accent/80` 是合法前景色写法，
 * 漏掉 `/` 会让它不被认作前景色，进而让「已处理选中态」的三元被判违规（实测 8 处误报）。
 */
const FOREGROUND_TOKEN = /^text-[a-z0-9/-]+$/;

/** 该 token 是否代表前景色（供 `ownForeground` 与规则文档共用同一判据） */
function isForegroundToken(token) {
  return FOREGROUND_TOKEN.test(token) && !FONT_SIZE_CLASS.test(token) && !token.includes('[');
}

/**
 * 从 className 属性值里取出 class token，按「可能同时成立」分组。
 *
 * ## 为什么必须分组
 *
 * 三元 / 逻辑表达式的各分支是**互斥**的：
 *
 * ```jsx
 * <button className={cn(
 *   'px-4 py-1.5',
 *   ok ? 'bg-accent-blue text-text-on-accent'   // 分支 A
 *      : 'bg-bg-tertiary text-text-muted',      // 分支 B
 * )} />
 * ```
 *
 * 若把 A、B 的 token 合进一个集合，就会得出
 * 「`bg-accent-blue` 上压着 `text-text-muted`」——**根本不存在的组合**。
 * 实测：本仓 4 个文件的 10 处告警全部源于此（PRCommentInput 的提交按钮、
 * RemoteDialog / WSLDialog / ProjectSettingsDialog 的下拉项）。
 *
 * 分组规则：
 * - 无条件串 / `cn()` 的固定参数 → 进入**每一组**（always）
 * - `cond ? 'a' : 'b'` → 分别开新组，与 always 求并集
 * - `cond && 'a'` → 单独一组（`a` 可能不存在）
 *
 * 返回 `string[][]`：每个子数组是一组「同时成立」的 class。
 */
function classTokenGroups(node) {
  /** always: 恒成立的 token；branches: 互斥的可选 token 组 */
  const always = new Set();
  const branches = [];

  const collect = (value, into) => {
    if (!value) return;
    // className={cn(...)} / className={cond ? 'a' : 'b'} —— 属性值是 JSXExpressionContainer，
    // 真正的 class 串在它包裹的 expression 里。漏了这层 → cn() 写法完全不判（用例 ⑦）。
    if (value.type === 'JSXExpressionContainer') {
      collect(value.expression, into);
      return;
    }
    if (value.type === 'Literal' && typeof value.value === 'string') {
      value.value.split(/\s+/).forEach((t) => t && into.add(t));
      return;
    }
    // 模板字符串 `bg-${x}` 无法静态判定 → 整体放弃（宁漏不误报）
    if (value.type === 'TemplateLiteral') return;

    if (value.type === 'LogicalExpression') {
      // `cond && 'cls'`：cls 单独成组
      const branch = new Set();
      collect(value.right, branch);
      if (branch.size) branches.push(branch);
      return;
    }
    if (value.type === 'ConditionalExpression') {
      // `cond ? 'a' : 'b'`：两个分支互斥，各成一组
      for (const arm of [value.consequent, value.alternate]) {
        const branch = new Set();
        collect(arm, branch);
        if (branch.size) branches.push(branch);
      }
      return;
    }
    if (value.type === 'CallExpression') {
      // cn(...) / clsx(...)：参数逐个收集。固定串进 always，
      // 条件参数各自成组（递归由上面的 LogicalExpression / ConditionalExpression 处理）。
      value.arguments.forEach((arg) => collect(arg, into));
    }
  };

  const attrs = node.openingElement ? node.openingElement.attributes : [];
  for (const attr of attrs) {
    if (attr.type !== 'JSXAttribute') continue;
    if (attr.name.name !== 'className') continue;
    collect(attr.value, always);
  }

  // 无分支 → 单组
  if (branches.length === 0) return [[...always]];
  // 每组 = always ∪ 该分支
  return branches.map((b) => [...always, ...b]);
}

/** 该元素自身是否是「实底 accent」（token 全等 —— 无前缀、无透明度后缀） */
function isSolidAccent(tokens) {
  return tokens.some((t) => SOLID_ACCENT.test(t));
}

/** 该元素自身带的前景色（若带了错的就直接违规） */
function ownForeground(tokens) {
  return tokens.filter(isForegroundToken);
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '压在实底 accent 上的元素，其前景色必须是 accent 底上的前景色（text-on-accent 系）',
      recommended: true,
    },
    schema: [],
    messages: {
      wrongForeground:
        '「{{token}}」压在 accent 实底上，应改用 accent 底上的前景色（text-text-on-accent / text-[var(--text-on-accent)]）。' +
        '理由：accent 实底上的正确前景色是 --text-on-accent，不是 --text-primary —— ' +
        '两者在暗色主题下差得极远（Claude 主题实测对比 1.11 ~ 1.41，几乎不可见）。',
    },
  },

  create(context) {
    const filePath = context.getFilename();
    // 只管 src/ 下的 tsx（CSS 由 check_ui_style_tokens 护栏覆盖）
    if (!/\.tsx?$/.test(filePath) || filePath.includes('node_modules')) return {};

    /** 逐组报告：哪一组里「accent 底 + 错前景色」同时成立就报哪一组 */
    function reportGroup(node, tokens) {
      if (!isSolidAccent(tokens)) return;
      for (const fg of ownForeground(tokens)) {
        if (!ON_ACCENT_FOREGROUND.test(fg)) {
          context.report({
            node: node.openingElement,
            messageId: 'wrongForeground',
            data: { token: fg },
          });
        }
      }
    }

    /** 检查一个 JSX 元素及其子树 */
    function checkElement(node) {
      if (!node || node.type !== 'JSXElement') return;

      const groups = classTokenGroups(node);
      groups.forEach((tokens) => reportGroup(node, tokens));

      // 该元素任一组是 accent 实底 → 其**子元素**上的前景色也必须合法
      const isAccentSomewhere = groups.some((tokens) => isSolidAccent(tokens));
      if (isAccentSomewhere) {
        for (const child of node.children || []) {
          checkChildUnderAccent(child);
        }
        return;
      }

      // 元素自身不是实底 accent → 继续往下找（可能某个祖先是）
      for (const child of node.children || []) {
        checkElement(child);
      }
    }

    /**
     * 实底 accent 的后代：检查其自身前景色。
     *
     * ## 为什么「任一组合法即放行」
     *
     * 选中项里的次级文字（命令、路径）几乎都写成三元：
     *
     * ```jsx
     * <span className={cn('ml-auto text-xs',
     *   selected ? 'text-text-on-accent/80' : 'text-text-muted')} />
     * ```
     *
     * 父元素的 accent 底本身也是条件分支（`selected && 'bg-accent-blue'`），
     * 但父子的分支条件在 AST 里是**两棵独立的子树**，无法机械对齐。
     * 若要求「每个分支都合法」，这条正确写法会被判违规。
     *
     * 所以判据取**存在性**：子元素只要有一组落在 on-accent 系，
     * 就说明作者已经处理了「压在 accent 上」的情形。
     */
    function checkChildUnderAccent(node) {
      if (!node || node.type !== 'JSXElement') return;

      const groups = classTokenGroups(node);
      const allForegrounds = groups.flatMap((tokens) => ownForeground(tokens));
      const handlesAccent = allForegrounds.some((fg) => ON_ACCENT_FOREGROUND.test(fg));

      if (!handlesAccent) {
        for (const fg of allForegrounds) {
          context.report({
            node: node.openingElement,
            messageId: 'wrongForeground',
            data: { token: fg },
          });
        }
      }
      // 递归更深的后代（实底 accent 的子元素里可能又嵌了实底 accent）
      for (const child of node.children || []) {
        checkChildUnderAccent(child);
      }
    }

    return {
      JSXElement: checkElement,
      JSXFragment(node) {
        for (const child of node.children || []) checkElement(child);
      },
    };
  },
};

// 只导出 rule 本体。plugin 聚合在 tools/eslint-rules/index.js。
module.exports = rule;
