/**
 * `ctrl+v` — paste the clipboard into the composer.
 *
 * ## The three branches, and the order they are tried in
 *
 * Copied from pi's `handleClipboardPaste`, including the order:
 *
 * 1. **File paths.** macOS Finder puts `file://` URLs on the clipboard rather than
 *    bytes, so this must come first — asking for an image there yields nothing and
 *    the paste silently loses the files.
 * 2. **An image.** Written to a temp file; **the path** is inserted, not an
 *    attachment.
 * 3. **Text.**
 *
 * ## Why an image becomes a file path instead of an attachment
 *
 * dsh has an attachment service with `saveImages`, so uploading would be possible.
 * It is the wrong shape here for three reasons:
 *
 * - The submission path (`runner.ts`'s `onSubmit`) sends *text*. Attaching would
 *   mean extending the message shape, the pending-message model, and the wire
 *   format — a protocol change to serve one keystroke.
 * - The agent has file tools. A path it can `read` is as useful as an attachment
 *   and needs no cooperation from the model adapter.
 * - It matches pi exactly, and the whole point of this round is that a pi user's
 *   reflexes behave the same way here.
 *
 * The tradeoff is real and worth stating: a temp file lives outside the session,
 * so it is not part of a resumed transcript and can be cleaned up by the OS. That
 * is pi's tradeoff too.
 *
 * ## Why the reader is injected
 *
 * The clipboard needs a display (X11, macOS pasteboard, Windows clipboard). A test
 * that reads the real one cannot run in CI, and a test that mocks a module-private
 * call pins the implementation. Taking a reader makes the three branches testable
 * as a decision table, which is the part with the bugs in it.
 *
 * @module dsh-neeko/tui/clipboard
 */

import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getNativeClipboard } from '@earendil-works/pi-tui'
import type { NativeClipboard } from '@earendil-works/pi-tui'

/**
 * What the paste turned into.
 *
 * `empty` and `unavailable` are separate on purpose: "your clipboard has nothing
 * pasteable" is a transient state the user can fix by copying something, while "this
 * platform has no clipboard we can read" is a limitation they should stop retrying.
 * Collapsing them into one "paste failed" makes the second look like the first.
 */
export type PasteResult =
  | { readonly kind: 'files'; readonly text: string }
  | { readonly kind: 'image'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'error'; readonly message: string }

/** Options for {@linkcode pasteClipboard}. */
export interface PasteOptions {
  /** Where to read from; `undefined` means this platform has no readable clipboard. */
  readonly clipboard: NativeClipboard | undefined
  /** Directory for a pasted image. The caller owns it so tests can point elsewhere. */
  readonly directory: string
  /** File-name generator, overridable so tests do not depend on a random id. */
  readonly makeName?: (extension: string) => string
}

/**
 * Media types the attachment vocabulary accepts.
 *
 * Deliberately narrow: writing a `.bmp` and telling the agent it is a `png` is
 * worse than refusing, because the failure surfaces much later as a decode error
 * with no connection to the paste that caused it.
 */
const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

/**
 * Every C0/C1 control character — what a **file path** may not contain.
 *
 * Newline included, and that is the point rather than an oversight: a filename
 * carrying `\n` is inserted into the editor and submitted from there, so one paste
 * silently becomes two messages. That is the shape of a command injection.
 */
const ANY_CONTROL = /\p{Cc}/u

/**
 * C0/C1 control characters, excluding the two the editor normalises.
 *
 * Newline and tab are legitimate in **text** — a multi-line paste is the reason
 * people paste — and pi-tui's editor converts both before storing. Everything else,
 * `ESC` above all, would reach the composer verbatim and be re-interpreted by this
 * program's own renderer.
 */
const UNSAFE_TEXT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u

/**
 * Read the clipboard and say what it turned into.
 *
 * @param options - the reader, the temp directory, and an optional name generator.
 * @returns the paste result; never throws.
 */
export async function pasteClipboard(options: PasteOptions): Promise<PasteResult> {
  const { clipboard, directory } = options
  if (clipboard === undefined) return { kind: 'unavailable' }

  try {
    const files = await readFiles(clipboard)
    if (files !== undefined) return files

    const image = await readImage(clipboard, directory, options.makeName)
    if (image !== undefined) return image

    const text = await clipboard.getText()
    // `null` means "the clipboard holds no text" and `undefined` means "this
    // platform cannot read text" — both are nothing to paste here. An **empty
    // string** is also nothing: inserting `''` leaves the editor unchanged, which
    // makes the key look broken. (Measured: collapsing the null/undefined arms into
    // the empty-string arm below changed no test, so they were one branch.)
    if (typeof text !== 'string' || text === '') return { kind: 'empty' }
    // Same rule as the file-path branch. The editor normalises line endings and tabs
    // and nothing else, so an `ESC` here would reach the composer verbatim and be
    // re-interpreted by the renderer.
    if (UNSAFE_TEXT_CONTROL.test(text)) {
      throw new Error('clipboard text contains control characters')
    }
    return { kind: 'text', text }
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The file-path branch.
 *
 * @param clipboard - the reader.
 * @returns a result when the clipboard held files, otherwise `undefined` so the
 *   caller can try the next branch.
 */
async function readFiles(clipboard: NativeClipboard): Promise<PasteResult | undefined> {
  const paths = await clipboard.getFilePaths?.()
  if (paths === undefined || paths === null || paths.length === 0) return undefined
  // The path is inserted into the editor and submitted from there. A newline in a
  // filename would silently split one paste into two prompts; other controls can
  // corrupt the frame. pi refuses the same case.
  if (paths.some((path) => ANY_CONTROL.test(path))) {
    throw new Error('clipboard file path contains control characters')
  }
  return { kind: 'files', text: paths.join('\n') }
}

/**
 * The image branch: write the bytes out and return the path.
 *
 * @param clipboard - the reader.
 * @param directory - where to write.
 * @param makeName - optional name generator.
 * @returns a result when the clipboard held an image, otherwise `undefined`.
 */
async function readImage(
  clipboard: NativeClipboard,
  directory: string,
  makeName: ((extension: string) => string) | undefined,
): Promise<PasteResult | undefined> {
  const image = await clipboard.getImage()
  if (image === undefined || image === null) return undefined
  const mediaType = sniffImageType(image)
  const extension = mediaType === undefined ? undefined : EXTENSION_BY_MEDIA_TYPE[mediaType]
  if (mediaType === undefined || extension === undefined) {
    throw new Error('unsupported clipboard image type: the bytes are not png, jpeg, webp, or gif')
  }
  const name = makeName === undefined
    ? `dsh-clipboard-${randomUUID()}${extension}`
    : makeName(extension)
  const path = join(directory, name)
  await writeFile(path, image)
  return { kind: 'image', text: path }
}

/**
 * Recover an image's media type from its magic bytes.
 *
 * `NativeClipboard.getImage()` returns **bare bytes** with no declared type, so the
 * extension has to be recovered from the content. Getting this wrong writes a file
 * whose name lies about its contents, which every downstream tool then has to guess
 * around — so an unrecognised signature is a refusal, not a default.
 *
 * @param bytes - the encoded image.
 * @returns the media type, or `undefined` when no known signature matches.
 */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  if (isPng(bytes)) return 'image/png'
  if (isJpeg(bytes)) return 'image/jpeg'
  if (isWebp(bytes)) return 'image/webp'
  if (isGif(bytes)) return 'image/gif'
  return undefined
}

/** PNG: `\x89PNG\r\n\x1a\n`. @param b - bytes. @returns whether it matches. */
function isPng(b: Uint8Array): boolean {
  return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
}

/** JPEG: `\xFF\xD8\xFF`. @param b - bytes. @returns whether it matches. */
function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
}

/** WebP: `RIFF....WEBP`. @param b - bytes. @returns whether it matches. */
function isWebp(b: Uint8Array): boolean {
  return b.length >= 12
    && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
}

/** GIF: `GIF87a` / `GIF89a`. @param b - bytes. @returns whether it matches. */
function isGif(b: Uint8Array): boolean {
  return b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46
}

/**
 * The platform's clipboard, or `undefined` when it has none.
 *
 * Kept as a function rather than a module-level constant so constructing one does
 * not open a display connection in a test that never pastes anything.
 *
 * @returns the reader, or `undefined`.
 */
export function platformClipboard(): NativeClipboard | undefined {
  return getNativeClipboard()
}
