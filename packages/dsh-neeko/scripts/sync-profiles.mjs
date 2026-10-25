#!/usr/bin/env node
/**
 * Copy the built `lib/` into every dsh profile that links this package.
 *
 * ## Why this exists
 *
 * A profile installs `dsh-neeko` as a **`file:` dependency** (see the neeko
 * profile's `package.json`), so pnpm links the *package directory* — but the
 * bundle reads `lib/`, and `lib/` is a build artifact. After `pnpm run build`
 * the profile therefore keeps serving the previous bundle until someone copies
 * the new one over. Nothing warns about it: the TUI simply keeps behaving like
 * before, which reads as "my change did nothing".
 *
 * That cost several debugging rounds in this repo (`/thinking` not appearing,
 * the fullscreen panel staying invisible, `/resume` showing no titles). The two
 * steps are one step now.
 *
 * ## What it does
 *
 * Scans `$DSH_HOME/profiles/*` for a `node_modules/dsh-neeko` that is a **link
 * to this package**, and copies `lib/` into it. Skips anything else, so it is
 * safe to run on a machine with unrelated profiles.
 *
 * @module dsh-neeko/scripts/sync-profiles
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This package's root directory. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every `*.js` / `*.d.ts` under `dir`, relative to it.
 *
 * Listed rather than shelled out to `cp -R` so the script behaves the same on
 * Windows, and so a stale file that no longer exists in `lib/` cannot survive in
 * the profile (that would be a build artifact from an older entry list).
 *
 * @param dir - the directory to walk.
 * @param prefix - the relative prefix accumulated so far.
 * @returns relative paths, files only.
 */
function walk(dir, prefix = '') {
  const entries = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const relative = prefix === '' ? name : join(prefix, name)
    if (statSync(full).isDirectory()) entries.push(...walk(full, relative))
    else entries.push(relative)
  }
  return entries
}

/**
 * Resolve `$DSH_HOME`, mirroring dsh's own default.
 * @returns the dsh home directory.
 */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** This package's name, so a profile copy can be recognized. */
const packageName = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name

/**
 * Whether `linkPath` is a copy of this package.
 *
 * A pnpm `file:` dependency is **not** a symlink — measured on this machine: the
 * profile holds a plain directory whose `realpath` is itself. So identity is the
 * package name, not the resolved path; a symlinked install also passes because
 * `package.json` is read through the link.
 *
 * @param linkPath - the profile's `node_modules/dsh-neeko`.
 * @returns true when it is this package.
 */
function isThisPackage(linkPath) {
  try {
    return JSON.parse(readFileSync(join(linkPath, 'package.json'), 'utf8')).name === packageName
  } catch {
    return false
  }
}

/**
 * Copy `lib/` into one profile's package copy.
 *
 * @param linkPath - the profile's `node_modules/dsh-neeko`.
 * @returns how many files were written.
 */
function syncLib(linkPath) {
  const source = join(packageRoot, 'lib')
  if (!existsSync(source)) {
    throw new Error('lib/ does not exist — run `pnpm run build` first')
  }
  let written = 0
  for (const relative of walk(source)) {
    const target = join(linkPath, 'lib', relative)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(source, relative), target)
    written += 1
  }
  // `cordis.patch.yml` is part of the runtime surface too: the row definitions
  // (which flags mount the TUI) live there, and a stale patch silently keeps the
  // old row config.
  const patch = join(packageRoot, 'cordis.patch.yml')
  if (existsSync(patch)) {
    copyFileSync(patch, join(linkPath, 'cordis.patch.yml'))
    written += 1
  }
  return written
}

/** Entry point. */
function main() {
  const home = dshHome()
  const profilesDir = join(home, 'profiles')
  if (!existsSync(profilesDir)) {
    console.log(`sync-profiles: no profiles under ${profilesDir} — nothing to do`)
    return
  }
  let total = 0
  for (const name of readdirSync(profilesDir)) {
    const linkPath = join(profilesDir, name, 'node_modules', 'dsh-neeko')
    if (!existsSync(linkPath) || !isThisPackage(linkPath)) continue
    const written = syncLib(linkPath)
    total += written
    console.log(`sync-profiles: ${name} → ${written} file(s)`)
  }
  if (total === 0) {
    console.log(`sync-profiles: no profile links this package (looked under ${profilesDir})`)
  } else {
    // Say what was *not* updated, so a second profile is not silently missed.
    console.log(`sync-profiles: ${total} file(s) copied from ${join(packageRoot, 'lib')}`)
  }
}

main()
