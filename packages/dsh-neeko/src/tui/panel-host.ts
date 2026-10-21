/**
 * The dock's single-occupant rule.
 *
 * ## Why this is a module
 *
 * The dock (`aboveInput`) carries four permanent rows: the interaction panel, the
 * theme line, the thinking line and the resume line. A selector *replaces* them
 * while it is open, because two menus sharing the dock would fight for the
 * keyboard and the vertical space.
 *
 * That rule was written three times — once per selector — and each copy owned its
 * own `Selector | undefined` field, its own `open`, its own `close`, and its own
 * `handleKey`. Three copies of one policy is how the dock was left empty the first
 * time a selector closed early: `clear()` removed the rows and only the
 * constructor ever put them back.
 *
 * ## What it does *not* know
 *
 * What a selector is for. `PanelHost` holds a `KeyedComponent` and forwards keys
 * to it; whether that component is a theme list, a thinking list or a session list
 * is the caller's business. That is what keeps a fourth selector from needing a
 * fourth copy of this.
 *
 * @module dsh-neeko/tui/panel-host
 */

import type { Component } from '@earendil-works/pi-tui'

/**
 * Something that can take the dock.
 *
 * The intersection the three selectors already share — `handleInput` is what the
 * app forwards to, and the rest is the component protocol. A new selector needs
 * nothing beyond this to be hosted.
 */
export interface KeyedComponent extends Component {
  handleInput(data: string): void
}

/** What the host needs from the app. */
export interface PanelHostOptions {
  /** The dock container: cleared and refilled as panels come and go. */
  readonly dock: {
    clear(): void
    addChild(component: Component): void
  }
  /**
   * Re-mount the rows the dock always carries.
   *
   * Called on every close, not just the first: a selector that closed after a
   * failed open must still leave the dock whole.
   */
  readonly restore: () => void
  /** Ask for a repaint; every mount and unmount changes the frame. */
  readonly requestRender: () => void
}

/**
 * The dock, with at most one selector on it.
 *
 * State is a single nullable slot, so "is a panel open" and "which panel" are the
 * same question — the three parallel `Selector | undefined` fields it replaces
 * could disagree, and a key would then be forwarded to a panel that had already
 * been replaced.
 */
export class PanelHost {
  private open: KeyedComponent | undefined

  constructor(private readonly options: PanelHostOptions) {}

  /** The panel currently on the dock, if any. */
  get current(): KeyedComponent | undefined {
    return this.open
  }

  /** Whether a panel owns the keyboard right now. */
  get isOpen(): boolean {
    return this.open !== undefined
  }

  /**
   * Put a panel on the dock, replacing whatever was there.
   *
   * Replacing rather than refusing is deliberate: `/theme` followed by `/thinking`
   * is a legitimate sequence (the user changed their mind), and the second panel
   * must win.
   *
   * @param panel - the component to host.
   */
  show(panel: KeyedComponent): void {
    this.open = panel
    this.options.dock.clear()
    this.options.dock.addChild(panel)
    this.options.requestRender()
  }

  /**
   * Take the dock back.
   *
   * Safe when nothing is open: callers close unconditionally (on escape, on
   * select, on teardown), and a guard here would only move the same check into
   * three call sites.
   */
  hide(): void {
    this.open = undefined
    this.options.dock.clear()
    this.options.restore()
    this.options.requestRender()
  }

  /**
   * Forward one keystroke to the open panel.
   *
   * @param data - the raw input chunk.
   * @returns whether a panel consumed it. `false` means the key belongs to
   *   whoever is next in the key scope stack — an absent panel must not swallow
   *   the keyboard.
   */
  handleKey(data: string): boolean {
    if (this.open === undefined) return false
    this.open.handleInput(data)
    this.options.requestRender()
    return true
  }
}
