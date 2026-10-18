/**
 * Command subsystem: dispatch decisions, host fallback, and the model catalogue
 * that `/model` completes against.
 *
 * Extracted from `TuiApp`'s `editor.onSubmit` closure, which had grown into a
 * 40-line `if/else if` chain over `CommandOutcome` **plus** the host-command
 * fallback **plus** model-list loading. Three concerns, one exit path.
 *
 * The first-principles fix behind this module: **routing must be driven by the
 * outcome's discriminant**, never by its text. The previous code detected
 * "unknown command" with `text.startsWith('unknown command:')`, so rewording a
 * message would silently stop host commands (`/compact`, `/skill:*`) from
 * running. `CommandOutcome` now carries an `unknown-command` variant and the
 * switch below is exhaustive.
 *
 * @module dsh-neeko/tui/command-controller
 */

import { runCommand } from './commands.ts'
import type { CommandOutcome } from './commands.ts'

/** One selectable model row. */
export interface ModelChoice {
  readonly id: string
  readonly name: string
  readonly provider: string
}

/** What the controller asks the app to do for one outcome. */
export type CommandAction =
  | { readonly kind: 'prompt'; readonly text: string }
  | /** A locally produced informational reply (`/help`, …). */
    { readonly kind: 'notice'; readonly text: string }
  | { readonly kind: 'clear' }
  | { readonly kind: 'exit' }
  | { readonly kind: 'model-picker' }
  | /** Apply a model id after validating it against the catalogue. */
    { readonly kind: 'select-model'; readonly id: string }
  | { readonly kind: 'theme-picker' }
  | { readonly kind: 'apply-theme'; readonly name: string }
  | { readonly kind: 'host'; readonly line: string; readonly name: string }

export interface CommandControllerOptions {
  /** Load the model catalogue once (idempotent). */
  readonly loadModels: () => Promise<readonly ModelChoice[]>
  /** Run a slash line against the host registry. */
  readonly runHostCommand?: (line: string) => Promise<{ kind: 'success' | 'error'; text?: string } | undefined>
}

/** A settled host command: its text plus whether it succeeded. */
export interface HostResult {
  readonly ok: boolean
  readonly text: string
}

/**
 * Turns one editor submission into an action, and runs host commands.
 *
 * The controller holds no UI state beyond the model catalogue; everything the
 * screen must change arrives as a {@linkcode CommandAction}.
 */
export class CommandController {
  private models: readonly ModelChoice[] = []
  private modelsLoaded = false

  constructor(private readonly options: CommandControllerOptions) {}

  /** The cached catalogue (`[]` until `ensureModels` resolves). */
  get modelCatalogue(): readonly ModelChoice[] {
    return this.models
  }

  /**
   * Classify one submission.
   *
   * Exhaustive over {@linkcode CommandOutcome}: adding a variant becomes a
   * compile error here rather than a silent fall-through.
   *
   * @param text - the raw editor line.
   * @returns the action the app should perform.
   */
  classify(text: string): CommandAction {
    const outcome: CommandOutcome = runCommand(text)
    switch (outcome.kind) {
      case 'not-a-command':
        return { kind: 'prompt', text }
      case 'unknown-command':
        // Owned by the host (a skill, /compact, …); it decides what happens.
        return { kind: 'host', line: outcome.line, name: outcome.name }
      case 'message':
        return { kind: 'notice', text: outcome.text }
      case 'clear':
        return { kind: 'clear' }
      case 'exit':
        return { kind: 'exit' }
      case 'pick-model':
        return { kind: 'model-picker' }
      case 'use-model':
        return { kind: 'select-model', id: outcome.id }
      case 'pick-theme':
        return { kind: 'theme-picker' }
      case 'use-theme':
        return { kind: 'apply-theme', name: outcome.name }
    }
  }

  /**
   * Load the model catalogue once; later calls reuse the result.
   *
   * An **empty** result is not cached: the first load can legitimately return
   * nothing (the provider registry may not be populated yet at construction
   * time, and the app warms the catalogue eagerly), and caching that would lock
   * `/model` out for the rest of the session — the failure looks like "model
   * switching stopped working" with no error anywhere. A failed load retries for
   * the same reason; only a non-empty catalogue is treated as settled.
   *
   * @returns the catalogue (possibly empty).
   */
  async ensureModels(): Promise<readonly ModelChoice[]> {
    if (this.modelsLoaded) return this.models
    try {
      const loaded = await this.options.loadModels()
      if (loaded.length > 0) {
        this.models = loaded
        this.modelsLoaded = true
      }
    } catch {
      // Fail open: `/model` reports "no models" and the rest of the TUI works.
      // Not cached, so a later attempt can still succeed.
    }
    return this.models
  }

  /**
   * Run a slash line against the host registry.
   * @param line - the raw submission.
   * @returns the settled result, or `undefined` when no host command matched.
   */
  async runOnHost(line: string): Promise<HostResult | undefined> {
    const run = this.options.runHostCommand
    if (run === undefined) return undefined
    try {
      const result = await run(line)
      if (result === undefined) return undefined
      return {
        ok: result.kind === 'success',
        text: result.text ?? (result.kind === 'success' ? 'done' : 'command failed'),
      }
    } catch (error: unknown) {
      return { ok: false, text: `command failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
}
