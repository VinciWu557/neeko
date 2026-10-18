/**
 * Theme subsystem: which theme is active, which ones exist, and the picker.
 *
 * Extracted from `TuiApp` because theme state (active theme, catalogue, picker
 * cursor, open/closed) is a self-contained concern with its own lifecycle and
 * its own keyboard mode. Keeping it inside the app class meant every theme
 * concern also touched the transcript, the status bar and the banner.
 *
 * The controller owns **state and policy**; painting stays with the caller via
 * the `onChange` callback, so this module has no dependency on pi-tui widgets.
 *
 * @module dsh-neeko/tui/theme-controller
 */

import { findBuiltin, listThemes, loadUserThemes, resolveTheme, resolveThemeByName, Theme } from './theme.ts'
import type { ThemeChoice, UserTheme } from './theme.ts'

/** What the picker currently shows, or `undefined` when closed. */
export interface ThemePickerView {
  readonly index: number
  readonly choices: readonly ThemeChoice[]
}

export interface ThemeControllerOptions {
  /** Theme name to start with. */
  readonly initialTheme?: string
  /** Theme files, injectable so tests need no filesystem. */
  readonly userThemes?: readonly UserTheme[]
}

/**
 * Owns the active theme and the picker.
 *
 * Invariants:
 * - `current` is never `undefined`; an unknown initial name falls back to the
 *   built-in dark theme rather than leaving the UI unthemed.
 * - A picker opened over an empty catalogue is a no-op (never an empty menu).
 */
export class ThemeController {
  private active: Theme
  private readonly userThemes: readonly UserTheme[]
  private readonly choices: readonly ThemeChoice[]
  private pickerIndex = 0
  private pickerOpen = false

  /** Fired after the active theme changes, so the owner can repaint. */
  onChange: ((theme: Theme) => void) | undefined

  constructor(options: ThemeControllerOptions = {}) {
    this.userThemes = options.userThemes ?? loadUserThemes()
    this.choices = listThemes(this.userThemes)
    this.active = resolveThemeByName(options.initialTheme ?? 'dark', this.userThemes)
      ?? resolveTheme(findBuiltin('dark')!)
  }

  /** The active theme. */
  get current(): Theme {
    return this.active
  }

  /** Every selectable theme (built-ins first, then user files). */
  get catalogue(): readonly ThemeChoice[] {
    return this.choices
  }

  /**
   * The picker's current view, or `undefined` when closed.
   * @returns the view the caller should render.
   */
  get picker(): ThemePickerView | undefined {
    return this.pickerOpen ? { index: this.pickerIndex, choices: this.choices } : undefined
  }

  /** Whether the picker owns the keyboard right now. */
  get isPickerOpen(): boolean {
    return this.pickerOpen
  }

  /**
   * Open the picker, positioned on the active theme.
   * @returns the initial view, or `undefined` when there is nothing to show.
   */
  openPicker(): ThemePickerView | undefined {
    if (this.choices.length === 0) return undefined
    this.pickerIndex = Math.max(0, this.choices.findIndex((choice) => choice.name === this.active.name))
    this.pickerOpen = true
    return this.picker
  }

  /** Close the picker without changing the theme. */
  closePicker(): void {
    this.pickerOpen = false
  }

  /**
   * Move the picker cursor, wrapping at both ends (pi's list behaviour).
   * @param delta - `-1` up, `+1` down.
   * @returns the updated view, or `undefined` when closed.
   */
  movePicker(delta: 1 | -1): ThemePickerView | undefined {
    if (!this.pickerOpen || this.choices.length === 0) return undefined
    const count = this.choices.length
    this.pickerIndex = (this.pickerIndex + delta + count) % count
    return this.picker
  }

  /**
   * Apply the theme under the picker cursor and close it.
   * @returns the applied theme, or `undefined` when the entry could not resolve.
   */
  confirmPicker(): Theme | undefined {
    const choice = this.choices[this.pickerIndex]
    this.pickerOpen = false
    if (choice === undefined) return undefined
    return this.apply(choice.name)
  }

  /**
   * Switch to a theme by name.
   * @param name - theme name (built-in or user file).
   * @returns the new theme, or `undefined` when the name is unknown.
   */
  apply(name: string): Theme | undefined {
    const next = resolveThemeByName(name, this.userThemes)
    if (next === undefined) return undefined
    this.active = next
    this.onChange?.(next)
    return next
  }

  /**
   * Whether a catalogue entry came from a user file.
   * @param name - theme name.
   * @returns `true` for custom themes.
   */
  isCustom(name: string): boolean {
    return this.choices.find((choice) => choice.name === name)?.sourcePath !== undefined
  }
}
