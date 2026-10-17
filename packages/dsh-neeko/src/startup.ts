/**
 * Command-line provider for the dsh-neeko profile. Owns the `dsh --profile
 * neeko` flag family and publishes an immutable {@link NeekoStartupValues}
 * service that the bridge row reads (via `!!js ctx.neekoStartup.*`).
 *
 * Two startup shapes are supported, mirroring the two launch directions in the
 * integration design:
 * - `dsh --profile neeko` — CLI mode: the bridge starts and, unless
 *   `--no-spawn`/`DSH_NEEKO_AUTOSPAWN=0`, launches Neeko with
 *   `--mode=dsh-agent` so the desktop shell opens straight into the chat.
 * - `dsh --profile neeko daemon` (or `--daemon`) — pure-wait mode: the bridge
 *   only serves health + WebSocket and never spawns Neeko. Neeko starts DSH
 *   this way when it finds the bridge down.
 *
 * @module dsh-neeko/startup
 */

import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { Command } from 'commander'

/** Stable Cordis plugin name. */
export const name = 'neeko-startup'

/** Services required before command-line parsing starts. */
export const inject = ['cmdlineArgs']

/** Service id published for the bridge row. */
export const NEEKO_STARTUP_SERVICE = 'neekoStartup'

/** The default bridge port, matching the integration design (non-3080). */
export const DEFAULT_PORT = 3081

/** The default bind host. */
export const DEFAULT_HOST = '127.0.0.1'

/** Immutable values resolved from this invocation. */
export interface NeekoStartupValues {
  /** Pure-wait mode: never spawn Neeko. */
  daemon?: boolean
  /** Bind host. */
  host?: string
  /** Preferred bridge port (falls back to higher ports when busy). */
  port?: number
  /** Resume an existing persisted session instead of creating a new one. */
  sessionId?: string
  /** Whether CLI mode may spawn Neeko. */
  autoSpawn?: boolean
  /** Override the command used to launch Neeko. */
  spawnCommand?: string
}

/** Flags as commander actually reports them. */
export interface StartupFlags {
  daemon?: boolean
  host?: string
  port?: string
  session?: string
  /**
   * `--spawn <cmd>` and `--no-spawn` share this key: a string, `false`, or absent.
   * Typing it as `string` only is what let `--no-spawn` write `false` into
   * `spawnCommand` (rejected by the Config schema, killing the whole row).
   */
  spawn?: string | false
}

/**
 * Resolve the startup service values from parsed flags.
 *
 * Pure so the three-state `spawn` handling is testable without a real argv:
 * - `spawn === false`      → `--no-spawn`: forbid spawning, no command.
 * - `spawn` is a string    → `--spawn <cmd>`: use that command, keep the default.
 * - `spawn === undefined`  → neither: leave both absent for the patch defaults.
 *
 * @param flags - parsed commander options.
 * @param positional - the optional mode positional (`daemon`).
 * @returns the immutable service values.
 */
export function resolveStartupValues(flags: StartupFlags, positional?: string): NeekoStartupValues {
  const daemon = flags.daemon === true || positional === 'daemon'
  const port = flags.port === undefined ? undefined : Number(flags.port)
  const sessionId = flags.session?.trim()
  return {
    ...(daemon ? { daemon: true } : {}),
    ...(flags.host === undefined ? {} : { host: flags.host }),
    ...(port === undefined ? {} : { port }),
    ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
    ...(flags.spawn === false ? { autoSpawn: false } : {}),
    ...(typeof flags.spawn === 'string' ? { spawnCommand: flags.spawn } : {}),
  }
}

function neekoCommand(): Command {
  return new Command()
    .name('dsh --profile neeko')
    .description('Run the dsh-neeko bridge: a WebSocket + health server that carries a bidirectional Agent Chat between DSH and the Neeko desktop shell.')
    .helpOption('-h, --help', 'show this help')
    .option('--daemon', 'pure-wait mode: serve health + WebSocket and never spawn Neeko')
    .option('--host <host>', `bind host (default ${DEFAULT_HOST})`)
    .option('--port <n>', `preferred bridge port (default ${DEFAULT_PORT}; falls back to +1..+9 when busy)`)
    .option('--session <id>', 'resume an existing persisted session')
    .option('--spawn <command>', 'override the command used to launch Neeko (e.g. "open -a Neeko")')
    .option('--no-spawn', 'do not spawn Neeko even in CLI mode')
    .argument('[mode]', "'daemon' runs the bridge in pure-wait mode (alias of --daemon)")
    .addHelpText('after', `
Examples:
  dsh --profile neeko                  start the bridge and spawn Neeko (dsh-agent mode)
  dsh --profile neeko daemon           pure-wait mode: wait for a Neeko connection
  dsh --profile neeko --port 3082      bind a specific port
  dsh --profile neeko --no-spawn       start the bridge without launching Neeko
`)
}

/**
 * Parse Neeko-owned arguments and publish the startup service.
 * @param ctx - plugin context carrying the immutable Harness command line.
 */
export function apply(ctx: Context): void {
  const program = neekoCommand()
  program.action(() => {
    const options = program.opts<StartupFlags>()
    const positional = program.args[0]
    if (positional !== undefined && positional !== 'daemon') program.error(`unknown mode: ${positional}`)
    const port = options.port === undefined ? undefined : Number(options.port)
    if (options.port !== undefined && !Number.isInteger(port) || port !== undefined && port <= 0) {
      program.error(`--port expects a positive integer, got ${JSON.stringify(options.port)}`)
    }
    if (options.session !== undefined && options.session.trim() === '') {
      program.error('--session requires a non-empty id')
    }
    ctx.provide(NEEKO_STARTUP_SERVICE, resolveStartupValues(options, positional))
  })
  parseCmdline(ctx, program)
}
