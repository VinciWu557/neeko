/**
 * Host-level fact readers for the TUI: package/version discovery, git branch,
 * DSH's context-pressure projection and the routed model's context window.
 *
 * Extracted from `runner.ts` for the same reason `host-commands.ts` was: the
 * composition root should *wire* facts, not compute them. These five readers
 * are pure functions of (filesystem, plugin context) and are the parts that
 * broke silently in the field — a wrong git branch or `unknown` version shows
 * no error anywhere, so they need direct tests against fakes and temp dirs.
 *
 * Every reader fails open: no repo, no service, no readable package →
 * `undefined` (or `'unknown'`), never a throw into the render path.
 *
 * @module dsh-neeko/tui/host-facts
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The slice of cordis's context these readers need (fake-able in tests). */
export interface HostContext {
  get(key: string): unknown
}

/** A package's identity as read from its `package.json`. */
export interface PackageIdentity {
  readonly name?: string
  readonly version?: string
}

/**
 * Walk up from a path looking for the package that owns it.
 * @param from - a file or directory inside the package.
 * @returns `{ name, version }`, or `undefined` when nothing matched.
 */
export function packageAt(from: string): PackageIdentity | undefined {
  try {
    let dir = dirname(realpathSync(from))
    for (let depth = 0; depth < 10; depth += 1) {
      try {
        return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageIdentity
      } catch {
        const parent = dirname(dir)
        if (parent === dir) return undefined
        dir = parent
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Resolve the file that holds `HEAD` for this working directory.
 *
 * - ordinary repo: `<cwd>/.git/HEAD` (`.git` is a directory);
 * - **linked worktree**: `.git` is a *file* pointing at the real admin dir
 *   (`gitdir: <path>`), so the directory form does not exist;
 * - outside a repo: `undefined`.
 *
 * @param cwd - the working directory.
 * @returns the HEAD path, or `undefined`.
 */
function gitHeadPath(cwd: string): string | undefined {
  const dotGit = join(cwd, '.git')
  const direct = join(dotGit, 'HEAD')
  if (existsSync(direct)) return direct
  try {
    const pointer = readFileSync(dotGit, 'utf8')
    const match = /^gitdir:\s*(.+)$/m.exec(pointer)
    const gitdir = match?.[1]
    if (gitdir === undefined) return undefined
    // The gitdir is usually absolute; a relative one resolves against cwd.
    return join(resolve(cwd, gitdir.trim()), 'HEAD')
  } catch {
    return undefined // no .git at all, or unreadable — the normal case outside a repo
  }
}

/**
 * Read the current git branch, or `undefined` outside a repo or on a detached
 * HEAD (whose `HEAD` is a raw sha, not a ref).
 *
 * @param cwd - the working directory.
 * @returns the branch name.
 */
export function gitBranch(cwd: string): string | undefined {
  try {
    const headPath = gitHeadPath(cwd)
    if (headPath === undefined) return undefined
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(readFileSync(headPath, 'utf8').trim())
    return match?.[1]
  } catch {
    return undefined
  }
}

/**
 * The harness version shown in the banner.
 *
 * Resolution order (first hit wins):
 * 1. `process.argv[1]` — the launcher, when it is the `dsh` bin itself.
 * 2. The module that loaded us — under `dsh --profile` the argv entry is the
 *    profile's own entry, so walking from argv rarely reaches `@deepseek-ai/dsh`;
 *    walk from this module instead.
 * 3. Our own package version, so the banner never prints `unknown` when a
 *    version exists at all.
 *
 * @param candidates - paths to walk from (defaults to the real-world order;
 *   tests inject their own).
 * @returns the version string.
 */
export function dshVersion(candidates: readonly string[] = defaultVersionCandidates()): string {
  for (const candidate of candidates) {
    const pkg = packageAt(candidate)
    if (pkg?.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string') return pkg.version
  }
  // Fall back to our own version (src|lib/tui/host-facts.js → ../../package.json).
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const own = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as PackageIdentity
    if (typeof own.version === 'string') return own.version
  } catch {
    // Nothing readable; the banner tolerates it.
  }
  return 'unknown'
}

/** The real-world candidate order for {@linkcode dshVersion}. */
function defaultVersionCandidates(): string[] {
  const candidates: string[] = []
  const bin = process.argv[1]
  if (bin !== undefined) candidates.push(bin)
  try {
    candidates.push(fileURLToPath(import.meta.url))
  } catch {
    // import.meta.url is always a file URL in ESM; guard anyway for bundlers.
  }
  return candidates
}

/**
 * Read DSH's own context-pressure projection.
 *
 * `contextPressure` carries `projectedTokens` (what the next request's prompt
 * would cost, anchored to the last provider report plus a heuristic delta) and
 * the route's `contextWindow`. That pair is exactly the `78.5%/1.0M` figure in
 * pi's footer, so there is nothing to compute locally.
 *
 * @param ctx - plugin context.
 * @param session - the live session.
 * @returns the projection, or `undefined` when the service is unavailable.
 */
export function readContextPressure(
  ctx: HostContext,
  session: unknown,
): { projectedTokens?: number; pressureTokens?: number; contextWindow?: number } | undefined {
  try {
    const registry = ctx.get('sessionProjections') as
      | { snapshot: (s: unknown, keys?: readonly string[]) => { values?: { contextPressure?: Record<string, unknown> } } }
      | undefined
    const snapshot = registry?.snapshot(session, ['contextPressure'])
    const pressure = snapshot?.values?.contextPressure
    if (pressure === undefined) return undefined
    const num = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined
    const projected = num(pressure['projectedTokens'])
    const sampled = num(pressure['pressureTokens'])
    const window = num(pressure['contextWindow'])
    return {
      ...(projected === undefined ? {} : { projectedTokens: projected }),
      ...(sampled === undefined ? {} : { pressureTokens: sampled }),
      ...(window === undefined ? {} : { contextWindow: window }),
    }
  } catch {
    return undefined
  }
}

/**
 * Look up the routed model's context window.
 * @param ctx - plugin context.
 * @param provider - route name.
 * @param model - model id.
 * @returns the window size, or `undefined` when unknown.
 */
export function contextWindowOf(ctx: HostContext, provider: string, model: string): number | undefined {
  try {
    const llm = ctx.get('llm') as { models?: readonly { provider: string; id: string; contextWindow?: number }[] } | undefined
    const entry = llm?.models?.find((candidate) => candidate.provider === provider && candidate.id === model)
    return entry?.contextWindow
  } catch {
    return undefined
  }
}
