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

/**
 * Token metadata: which colour slot a token paints, and what it inherits when a
 * theme omits it.
 *
 * Transcribed from pi's `theme-tokens.js` so a **pi theme file resolves
 * identically** here. The `fallback` field is load-bearing, not cosmetic: pi's
 * own `dark.json` and `light.json` both omit `scrollbarTrack`, `scrollbarThumb`,
 * `searchMatchBg` and `searchMatchText`, relying on the chain below. A loader
 * without it rejects every stock pi theme with
 * `Theme token scrollbarTrack has unresolved fallback muted` — which is exactly
 * what this build did before the metadata existed.
 */
export interface ThemeTokenSpec {
  /** Which escape channel the token paints: foreground or background. */
  readonly slot: 'foreground' | 'background'
  /** Token to inherit when a theme omits this one. Same slot, by construction. */
  readonly fallback?: ThemeToken
}

/**
 * Every token with its slot, in pi's declaration order.
 *
 * Background tokens are the seven that fill a band (`Box(1, 1, bg)` and the
 * select-list highlight); everything else is a foreground colour.
 */
export const THEME_TOKEN_SPECS: Readonly<Record<ThemeToken, ThemeTokenSpec>> = {
  accent: { slot: 'foreground' },
  border: { slot: 'foreground' },
  borderAccent: { slot: 'foreground' },
  borderMuted: { slot: 'foreground' },
  success: { slot: 'foreground' },
  error: { slot: 'foreground' },
  warning: { slot: 'foreground' },
  muted: { slot: 'foreground' },
  dim: { slot: 'foreground' },
  text: { slot: 'foreground' },
  thinkingText: { slot: 'foreground' },
  scrollbarTrack: { slot: 'foreground', fallback: 'muted' },
  scrollbarThumb: { slot: 'foreground', fallback: 'text' },
  selectedBg: { slot: 'background' },
  searchMatchBg: { slot: 'background', fallback: 'selectedBg' },
  searchMatchText: { slot: 'foreground', fallback: 'text' },
  userMessageBg: { slot: 'background' },
  userMessageText: { slot: 'foreground' },
  customMessageBg: { slot: 'background' },
  customMessageText: { slot: 'foreground' },
  customMessageLabel: { slot: 'foreground' },
  toolPendingBg: { slot: 'background' },
  toolSuccessBg: { slot: 'background' },
  toolErrorBg: { slot: 'background' },
  toolTitle: { slot: 'foreground' },
  toolOutput: { slot: 'foreground' },
  mdHeading: { slot: 'foreground' },
  mdLink: { slot: 'foreground' },
  mdLinkUrl: { slot: 'foreground' },
  mdCode: { slot: 'foreground' },
  mdCodeBlock: { slot: 'foreground' },
  mdCodeBlockBorder: { slot: 'foreground' },
  mdQuote: { slot: 'foreground' },
  mdQuoteBorder: { slot: 'foreground' },
  mdHr: { slot: 'foreground' },
  mdListBullet: { slot: 'foreground' },
  toolDiffAdded: { slot: 'foreground' },
  toolDiffRemoved: { slot: 'foreground' },
  toolDiffContext: { slot: 'foreground' },
  syntaxComment: { slot: 'foreground' },
  syntaxKeyword: { slot: 'foreground' },
  syntaxFunction: { slot: 'foreground' },
  syntaxVariable: { slot: 'foreground' },
  syntaxString: { slot: 'foreground' },
  syntaxNumber: { slot: 'foreground' },
  syntaxType: { slot: 'foreground' },
  syntaxOperator: { slot: 'foreground' },
  syntaxPunctuation: { slot: 'foreground' },
  thinkingOff: { slot: 'foreground' },
  thinkingMinimal: { slot: 'foreground' },
  thinkingLow: { slot: 'foreground' },
  thinkingMedium: { slot: 'foreground' },
  thinkingHigh: { slot: 'foreground' },
  thinkingXhigh: { slot: 'foreground' },
  thinkingMax: { slot: 'foreground' },
  bashMode: { slot: 'foreground' },
}
