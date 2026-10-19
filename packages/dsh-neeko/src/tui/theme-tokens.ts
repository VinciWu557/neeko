/**
 * The theme token vocabulary.
 *
 * ## Why this is its own module
 *
 * `ThemeToken` is a **pure type plus a frozen word list**: it names the palette
 * slots a theme may fill and nothing else. Keeping it here is what lets
 * `highlight.ts` say "paint this span with `syntaxKeyword`" without importing the
 * palette loader — which would have made `theme.ts` and `highlight.ts` import
 * each other (a genuine cycle, not a style preference).
 *
 * The list is pi's, so a **pi theme file works unchanged**: locking it to the
 * dozen tokens this TUI paints today would reject valid pi themes outright and
 * silently drop their Markdown / syntax colours. Rendering still only reads what
 * it uses.
 *
 * @module dsh-neeko/tui/theme-tokens
 */

/**
 * Every theme token pi defines (56), in pi's own order.
 *
 * Transcribed from `pi-coding-agent`'s `theme-tokens.js`.
 */
export const THEME_TOKENS = [
  'accent', 'border', 'borderAccent', 'borderMuted', 'success', 'error',
  'warning', 'muted', 'dim', 'text', 'thinkingText', 'scrollbarTrack',
  'scrollbarThumb', 'selectedBg', 'searchMatchBg', 'searchMatchText', 'userMessageBg', 'userMessageText',
  'customMessageBg', 'customMessageText', 'customMessageLabel', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg',
  'toolTitle', 'toolOutput', 'mdHeading', 'mdLink', 'mdLinkUrl', 'mdCode',
  'mdCodeBlock', 'mdCodeBlockBorder', 'mdQuote', 'mdQuoteBorder', 'mdHr', 'mdListBullet',
  'toolDiffAdded', 'toolDiffRemoved', 'toolDiffContext', 'syntaxComment', 'syntaxKeyword', 'syntaxFunction',
  'syntaxVariable', 'syntaxString', 'syntaxNumber', 'syntaxType', 'syntaxOperator', 'syntaxPunctuation',
  'thinkingOff', 'thinkingMinimal', 'thinkingLow', 'thinkingMedium', 'thinkingHigh', 'thinkingXhigh',
  'thinkingMax', 'bashMode',
] as const

/** A theme token name. */
export type ThemeToken = (typeof THEME_TOKENS)[number]
