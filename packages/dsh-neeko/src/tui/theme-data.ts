/**
 * Built-in theme palettes — data only, no parsing and no filesystem access.
 *
 * Split out of `theme.ts` for one concrete reason: this file is 146 lines of
 * pure JSON-shaped literals, and keeping it beside the resolver forced anything
 * that merely wanted a palette to pull in `node:fs` (the custom-theme loader).
 * Data has no dependencies; the loader and the resolver do.
 *
 * The values are **transcribed verbatim** from pi's
 * `dist/modes/interactive/theme/{dark,light}.json` (all 56 tokens each). They
 * are copied rather than read at runtime because pi's package `exports` does not
 * expose those paths — a comment marks the source so a refresh is a mechanical
 * diff.
 *
 * @module dsh-neeko/tui/theme-data
 */

import type { ThemeToken } from './theme.ts'

export interface ThemeDocument {
  readonly name: string
  readonly appearance?: 'dark' | 'light'
  /** Named colors referenced by `colors`. */
  readonly vars?: Readonly<Record<string, string>>
  /** Token → var name or literal color. */
  readonly colors: Readonly<Partial<Record<ThemeToken, string>>>
}

export const BUILTIN_THEMES: readonly ThemeDocument[] = [
  {
    name: 'dark',
    appearance: 'dark',
    vars: {
      text: 'okhsl(234 3% 89%)',
      muted: 'okhsl(229 6% 67%)',
      violet: 'okhsl(295 50% 67%)',
      blue: 'okhsl(232 54% 67%)',
      green: 'okhsl(159 59% 67%)',
      red: 'okhsl(20 72% 67%)',
      yellow: 'okhsl(83 88% 67%)',
      blueBg: 'okhsl(233 41% 24%)',
    },
    colors: {
      accent: 'violet',
      border: 'okhsl(231 57% 65%)',
      borderAccent: 'okhsl(295 53% 64%)',
      borderMuted: 'okhsl(229 8% 53%)',
      success: 'green',
      error: 'red',
      warning: 'yellow',
      muted: 'muted',
      dim: 'okhsl(229 8% 56%)',
      text: 'text',
      thinkingText: 'okhsl(226 7% 65%)',
      selectedBg: 'blueBg',
      scrollbarTrack: 'okhsl(237 7% 33%)',
      scrollbarThumb: 'okhsl(232 7% 65%)',
      searchMatchBg: 'okhsl(53 51% 24%)',
      searchMatchText: 'muted',
      userMessageBg: 'blueBg',
      userMessageText: 'text',
      customMessageBg: 'okhsl(295 42% 24%)',
      customMessageText: 'muted',
      customMessageLabel: 'violet',
      toolPendingBg: 'okhsl(229 5% 24%)',
      toolSuccessBg: 'okhsl(158 46% 25%)',
      toolErrorBg: 'okhsl(19 54% 25%)',
      toolTitle: 'text',
      toolOutput: 'muted',
      mdHeading: 'yellow',
      mdLink: 'blue',
      mdLinkUrl: 'muted',
      mdCode: 'violet',
      mdCodeBlock: 'green',
      mdCodeBlockBorder: 'muted',
      mdQuote: 'muted',
      mdQuoteBorder: 'muted',
      mdHr: 'muted',
      mdListBullet: 'violet',
      toolDiffAdded: 'green',
      toolDiffRemoved: 'red',
      toolDiffContext: 'muted',
      syntaxComment: 'muted',
      syntaxKeyword: 'blue',
      syntaxFunction: 'yellow',
      syntaxVariable: 'okhsl(202 58% 67%)',
      syntaxString: 'okhsl(52 67% 67%)',
      syntaxNumber: 'green',
      syntaxType: 'violet',
      syntaxOperator: 'muted',
      syntaxPunctuation: 'muted',
      thinkingOff: 'okhsl(229 8% 49%)',
      thinkingMinimal: 'okhsl(232 20% 52%)',
      thinkingLow: 'okhsl(232 45% 54%)',
      thinkingMedium: 'okhsl(263 59% 56%)',
      thinkingHigh: 'okhsl(295 73% 59%)',
      thinkingXhigh: 'okhsl(337 81% 61%)',
      thinkingMax: 'okhsl(20 99% 63%)',
      bashMode: 'okhsl(159 64% 65%)',
    },
  },
  {
    name: 'light',
    appearance: 'light',
    vars: {
      text: 'okhsl(225 5% 27%)',
      muted: 'okhsl(229 8% 47%)',
      violet: 'okhsl(295 60% 46%)',
      blue: 'okhsl(231 68% 47%)',
      green: 'okhsl(159 75% 46%)',
      red: 'okhsl(20 91% 47%)',
      yellow: 'okhsl(83 99% 47%)',
      blueBg: 'okhsl(235 19% 91%)',
    },
    colors: {
      accent: 'violet',
      border: 'okhsl(231 67% 55%)',
      borderAccent: 'okhsl(295 59% 55%)',
      borderMuted: 'okhsl(235 7% 66%)',
      success: 'green',
      error: 'red',
      warning: 'yellow',
      muted: 'muted',
      dim: 'okhsl(229 7% 59%)',
      text: 'text',
      thinkingText: 'okhsl(234 8% 55%)',
      selectedBg: 'blueBg',
      scrollbarTrack: 'okhsl(248 3% 90%)',
      scrollbarThumb: 'okhsl(226 7% 65%)',
      searchMatchBg: 'okhsl(56 22% 91%)',
      searchMatchText: 'muted',
      userMessageBg: 'blueBg',
      userMessageText: 'text',
      customMessageBg: 'okhsl(295 25% 91%)',
      customMessageText: 'muted',
      customMessageLabel: 'violet',
      toolPendingBg: 'okhsl(248 3% 91%)',
      toolSuccessBg: 'okhsl(156 21% 91%)',
      toolErrorBg: 'okhsl(24 23% 91%)',
      toolTitle: 'text',
      toolOutput: 'muted',
      mdHeading: 'yellow',
      mdLink: 'blue',
      mdLinkUrl: 'muted',
      mdCode: 'violet',
      mdCodeBlock: 'green',
      mdCodeBlockBorder: 'muted',
      mdQuote: 'muted',
      mdQuoteBorder: 'muted',
      mdHr: 'muted',
      mdListBullet: 'violet',
      toolDiffAdded: 'green',
      toolDiffRemoved: 'red',
      toolDiffContext: 'muted',
      syntaxComment: 'muted',
      syntaxKeyword: 'blue',
      syntaxFunction: 'yellow',
      syntaxVariable: 'okhsl(203 73% 46%)',
      syntaxString: 'okhsl(52 84% 46%)',
      syntaxNumber: 'green',
      syntaxType: 'violet',
      syntaxOperator: 'muted',
      syntaxPunctuation: 'muted',
      thinkingOff: 'okhsl(223 5% 80%)',
      thinkingMinimal: 'okhsl(229 14% 78%)',
      thinkingLow: 'okhsl(232 33% 76%)',
      thinkingMedium: 'okhsl(264 48% 74%)',
      thinkingHigh: 'okhsl(295 62% 72%)',
      thinkingXhigh: 'okhsl(337 74% 70%)',
      thinkingMax: 'okhsl(20 98% 68%)',
      bashMode: 'okhsl(159 74% 55%)',
    },
  },
]
