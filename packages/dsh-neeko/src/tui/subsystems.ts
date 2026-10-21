/**
 * The subsystems, built in one place.
 *
 * ## Why this is a function and not constructor code
 *
 * `TuiApp`'s constructor used to answer two questions in one 100-line body:
 * *which subsystems exist* and *what is on screen*. They are unrelated — a
 * subsystem is created once and never re-laid-out; the widget tree is a static
 * shape — and mixing them made either one unreadable without the other.
 *
 * Three of the four need callbacks into the app (`showStatus`, `addNotice`,
 * `requestRender`), so they cannot be built before the app exists. Passing them in
 * as {@linkcode SubsystemHost} keeps the dependency one-way: this module never
 * imports `TuiApp`.
 *
 * ## What it is not
 *
 * Not a container. It returns the four controllers and nothing else — no wiring
 * between them, no listeners. That belongs to the app, which owns the lifetime.
 *
 * @module dsh-neeko/tui/subsystems
 */

import { CommandController } from './command-controller.ts'
import { ResumeController } from './resume-controller.ts'
import { StatusController } from './status-controller.ts'
import { ThemeController } from './theme-controller.ts'
import type { LiveStatusFacts } from './status-controller.ts'
import type { ResumeSource } from './resume-list.ts'
import type { Theme } from './theme.ts'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'

/** The app-side callbacks a subsystem needs. */
export interface SubsystemHost {
  /** One-line status under the editor (the self-clearing notice slot). */
  readonly showStatus: (text: string) => void
  /** A reply in the transcript. */
  readonly addNotice: (text: string, tone: 'text' | 'muted' | 'error') => void
}

/** What the app supplies to {@linkcode createSubsystems}. */
export interface SubsystemOptions extends SubsystemHost {
  /** Start this theme, or `undefined` for the controller's default. */
  readonly initialTheme?: string | undefined
  /** The model catalogue, read lazily by `/model`. */
  readonly modelPicker: () => Promise<{ models: readonly {
    id: string; name: string; provider: string; isDefault?: boolean
  }[] }>
  /** Run one slash line against the DSH command registry. */
  readonly runHostCommand?: ((line: string) => Promise<{ kind: 'success' | 'error'; text?: string } | undefined>) | undefined
  /** The session corpus; absent means "this build cannot list sessions". */
  readonly listSessions?: (() => Promise<readonly ResumeSource[]>) | undefined
  /** Folded titles for a page of ids. */
  readonly sessionTitles?: ((ids: readonly string[]) => Promise<Readonly<Record<string, string>>>) | undefined
  /** Switch the live agent to another session. */
  readonly resumeSession?: ((sessionId: string) => void) | undefined
  /** The session currently attached. */
  readonly getSessionId: () => string
  /** Live status, recomputed on demand. */
  readonly statusFacts: () => LiveStatusFacts
  /** The model route in effect. */
  readonly getSelection: () => ModelSelection
}

/** The four controllers the app drives. */
export interface Subsystems {
  readonly themes: ThemeController
  readonly commands: CommandController
  readonly resumeList: ResumeController
  readonly status: StatusController
}

/**
 * Build the four subsystems.
 *
 * @param options - the host callbacks plus each subsystem's own sources.
 * @returns the controllers, unwired.
 */
export function createSubsystems(options: SubsystemOptions): Subsystems {
  const themes = new ThemeController(
    options.initialTheme === undefined ? {} : { initialTheme: options.initialTheme },
  )
  const commands = new CommandController({
    loadModels: async () => (await options.modelPicker()).models,
    ...(options.runHostCommand === undefined ? {} : { runHostCommand: options.runHostCommand }),
  })
  // The controller owns the listing and the paging; the app supplies the host
  // calls and the two ways a result becomes visible.
  const resumeList = new ResumeController({
    // The host may decline to offer session switching at all (`--session`
    // builds); that is reported once, not per keystroke.
    listSessions: options.listSessions ?? (async () => {
      throw new Error('this build cannot list sessions')
    }),
    ...(options.sessionTitles === undefined ? {} : { sessionTitles: options.sessionTitles }),
    resumeSession: (sessionId) => { options.resumeSession?.(sessionId) },
    currentSessionId: () => options.getSessionId(),
    onStatus: (text) => { options.showStatus(text) },
    onNotice: (text, tone) => { options.addNotice(text, tone) },
  })
  const status = new StatusController({
    readFacts: options.statusFacts,
    route: () => options.getSelection(),
    theme: (): Theme => themes.current,
  })
  return { themes, commands, resumeList, status }
}
