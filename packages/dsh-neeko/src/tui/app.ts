/**
 * TuiApp: screen assembly and key routing for the DSH TUI.
 *
 * Layout (minimal MVP, design §3):
 *
 * ```
 * TuiMainScreen
 *  ├─ header Text        (title + model)
 *  ├─ messages Container (transcript lines; filled by the transcript layer)
 *  ├─ working Text       (status line: thinking / executing / awaiting human)
 *  ├─ Editor             (focused by default)
 *  └─ footer Text        (key hints)
 * ```
 *
 * The app owns no agent logic — it renders what the transcript layer feeds it
 * and routes keys to the active interaction (question → approval → editor).
 *
 * @module dsh-neeko/tui/app
 */

import { TuiMainScreen } from '@earendil-works/pi-tui'
import { Editor } from '@earendil-works/pi-tui'
import { Container } from '@earendil-works/pi-tui'
import { Text } from '@earendil-works/pi-tui'
import { ProcessTerminal } from '@earendil-works/pi-tui'
import { matchesKey, isKeyRelease, isKeyRepeat } from '@earendil-works/pi-tui'
import type { Component } from '@earendil-works/pi-tui'
import { renderRow, type TranscriptState } from './transcript.ts'
import { InteractionManager } from './interactions.ts'
import { runCommand } from './commands.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** Plain (colorless) editor theme; a real palette is R3 scope. */
const editorTheme = {
  borderColor: (text: string) => text,
  selectList: {
    selectedPrefix: (text: string) => `> ${text}`,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
  },
}

/** Coalesced repaint interval for streaming events, in ms. */
const REPAINT_FLUSH_MS = 50

export interface TuiAppOptions {
  readonly agent: Agent
  readonly selection: { readonly provider: string; readonly model: string }
  readonly getSessionId: () => string
  /** Fired when the editor submits a line (Enter). */
  readonly onSubmit: (text: string) => void
  /** Invoked on Ctrl+C / Ctrl+D — the owner stops the app and exits. */
  readonly onExit: () => void
}

/**
 * The interactive screen. Starts raw mode on {@linkcode TuiApp.start}, restores
 * the terminal on {@linkcode TuiApp.stop}.
 */
export class TuiApp {
  private readonly tui: TuiMainScreen
  private readonly editor: Editor
  private readonly header: Text
  private readonly messages: Container
  private readonly working: Text
  private readonly footer: Text
  private interactionText: Text
  private exited = false
  private scheduleRender: (() => void) | undefined
  /** The active approval / question interaction, if any. */
  readonly interactions = new InteractionManager()

  constructor(private readonly options: TuiAppOptions) {
    this.tui = new TuiMainScreen(new ProcessTerminal())
    this.header = new Text(`dsh tui — ${options.selection.provider}/${options.selection.model} (${options.getSessionId()})`)
    this.messages = new Container()
    this.working = new Text('')
    this.editor = new Editor(this.tui, editorTheme)
    this.footer = new Text('enter send · ctrl+c exit')

    this.tui.addChild(this.header)
    this.tui.addChild(this.messages)
    this.tui.addChild(this.working)
    this.interactionText = new Text('')
    this.tui.addChild(this.interactionText)
    this.tui.addChild(this.editor)
    this.tui.addChild(this.footer)
    this.tui.setFocus(this.editor)
    this.editor.onSubmit = (text: string) => {
      const outcome = runCommand(text, options.selection)
      if (outcome.kind === 'not-a-command') {
        options.onSubmit(text)
        return
      }
      this.editor.setText('')
      if (outcome.kind === 'message') {
        this.addMessage(new Text(outcome.text))
      } else if (outcome.kind === 'clear') {
        this.clearTranscript()
      } else if (outcome.kind === 'exit') {
        options.onExit()
      }
    }
    this.tui.addInputListener((data) => this.handleInput(data))
  }

  /** Enter raw mode and start rendering. */
  start(): void {
    this.tui.start()
    this.requestRender()
  }

  /** Whether the screen is currently rendering (raw mode on). */
  get isRunning(): boolean {
    return !this.exited
  }

  /** Leave raw mode; safe to call twice. */
  stop(): void {
    if (this.exited) return
    this.exited = true
    this.tui.stop()
  }

  /**
   * Bind the transcript: re-render the messages container from its rows on
   * every repaint, with a 50ms coalescing window (design §3 — per-token
   * full repaints are the streaming killer).
   */
  mountTranscript(state: TranscriptState): void {
    let scheduled: ReturnType<typeof setTimeout> | undefined
    const flush = (): void => {
      scheduled = undefined
      // Rebuild only when the row list actually changed; the transcript mutates
      // in place, so identity comparison must be on length + last row text.
      const rendered = state.rows.map((row) => renderRow(row))
      this.messages.clear()
      for (const component of rendered) this.messages.addChild(component)
      this.requestRender()
    }
    this.scheduleRender = (): void => {
      if (scheduled !== undefined) return
      scheduled = setTimeout(flush, REPAINT_FLUSH_MS)
    }
    flush()
  }

  /** Schedule a repaint (coalesced by the TUI). */
  requestRender(): void {
    this.scheduleRender?.()
    this.tui.requestRender()
  }

  /** Append one rendered component to the transcript area. */
  addMessage(component: Component): void {
    this.messages.addChild(component)
    this.requestRender()
  }

  /** Remove every transcript row (view only — the session log is untouched). */
  clearTranscript(): void {
    this.messages.clear()
    this.requestRender()
  }

  /** Refresh the inline interaction panel from the manager's current view. */
  refreshInteraction(): void {
    const view = this.interactions.current
    if (view === undefined) {
      this.interactionText.setText('')
    } else if (view.kind === 'approval') {
      this.interactionText.setText(
        `⚠ approve ${view.toolName}${view.reason === undefined ? '' : ` — ${view.reason}`}\n[y] allow   [n] reject   [esc] cancel`)
    } else {
      const optionLines = view.options.length === 0
        ? '(type your answer, enter to submit)'
        : view.options.map((option) => `  ${Number(option.id) + 1}. ${option.label}`).join('\n')
      this.interactionText.setText(`? (${view.index}/${view.total}) ${view.question}\n${optionLines}`)
    }
    this.requestRender()
  }

  /** Update the working/status line; empty string hides it. */
  setWorking(text: string): void {
    this.working.setText(text)
    this.requestRender()
  }

  /** Seed the editor input history (e.g. from a resumed session). */
  seedHistory(entries: string[]): void {
    for (const entry of entries) this.editor.addToHistory(entry)
  }

  /**
   * Shared key routing: exit, then component focus. Interactions (question /
   * approval) hook in later as higher-priority listeners.
   */
  private handleInput(data: string): { consume?: boolean } | undefined {
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined
    if (matchesKey(data, 'ctrl+c') || matchesKey(data, 'ctrl+d')) {
      this.options.onExit()
      return { consume: true }
    }
    // Interaction keys take priority over the editor while one is active.
    if (this.interactions.busy) return this.handleInteractionKey(data)
    return undefined
  }

  private handleInteractionKey(data: string): { consume?: boolean } | undefined {
    const view = this.interactions.current
    if (view === undefined) return undefined
    if (view.kind === 'approval') {
      if (matchesKey(data, 'y')) { this.interactions.allowApproval(); this.refreshInteraction(); return { consume: true } }
      if (matchesKey(data, 'n')) { this.interactions.rejectApproval(); this.refreshInteraction(); return { consume: true } }
      if (matchesKey(data, 'escape')) {
        // ESC cancels via the abort path; the manager settles the promise.
        this.interactions.cancelAll()
        this.refreshInteraction()
        return { consume: true }
      }
      return { consume: true } // swallow editor input while an approval is up
    }
    // question view
    const optionKey = /^[1-9]$/.exec(data)
    if (optionKey !== null && view.options.length > 0) {
      const option = view.options[Number(optionKey[0]) - 1]
      if (option !== undefined) {
        this.interactions.answerQuestion(option.label)
        this.refreshInteraction()
        return { consume: true }
      }
    }
    return undefined // free-text questions fall through to the editor
  }
}
