import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pasteClipboard } from '../src/tui/clipboard.ts'

/**
 * `ctrl+v` — paste the clipboard into the editor.
 *
 * ## The shape this copies, and why
 *
 * pi's `handleClipboardPaste` tries three things in order and takes the first that
 * answers:
 *
 * 1. **File paths** (macOS Finder copies `file://` URLs) → insert the paths.
 * 2. **An image** → write it to a temp file and insert *the path*.
 * 3. **Text** → insert the text.
 *
 * Step 2 is the interesting one: the image is **not** uploaded as an attachment.
 * It becomes a file on disk and the editor gets a path, which the agent then reads
 * with its own file tools. That is why this needs no protocol change on either
 * side — and why an image pasted here behaves exactly like one the user typed the
 * path of.
 *
 * ## What is asserted
 *
 * The *decision*, not the clipboard. `pasteClipboard` takes a reader, so the three
 * branches are testable without a display, a TTY, or a real clipboard — which is
 * the only reason this can run in CI at all.
 */

/** A reader that answers with whatever the test set, recording that it was asked. */
function reader(answer: {
  files?: string[] | null
  image?: Uint8Array | null
  text?: string | null
}): { clipboard: Parameters<typeof pasteClipboard>[0]['clipboard']; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    clipboard: {
      getFilePaths: async () => { calls.push('files'); return answer.files ?? null },
      getImage: async () => { calls.push('image'); return answer.image ?? null },
      getText: async () => { calls.push('text'); return answer.text ?? null },
    },
  }
}

/** A temp directory that the pasted image should land in. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-paste-'))
}

describe('pasteClipboard — the three branches, in pi\'s order', () => {
  it('inserts file paths when the clipboard holds files', async () => {
    // macOS Finder puts `file://` URLs on the clipboard, not bytes.
    const { clipboard, calls } = reader({ files: ['/tmp/a.png', '/tmp/b.png'] })
    const result = await pasteClipboard({ clipboard, directory: tempDir() })
    expect(result.kind).toBe('files')
    if (result.kind !== 'files') throw new Error('expected a files result')
    expect(result.text).toContain('/tmp/a.png')
    expect(result.text).toContain('/tmp/b.png')
    // The other two are never asked: the first answer wins.
    expect(calls).toEqual(['files'])
  })

  it('writes an image to a file and inserts that path', async () => {
    // Not an attachment upload: a path the agent can read with its own tools.
    const dir = tempDir()
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const { clipboard } = reader({ image: bytes })
    const result = await pasteClipboard({ clipboard, directory: dir })

    expect(result.kind).toBe('image')
    const written = readdirSync(dir)
    expect(written).toHaveLength(1)
    if (result.kind !== 'image') throw new Error('expected an image result')
    expect(result.text).toContain(written[0] as string)
    // The bytes must be the exact ones the clipboard gave.
    expect([...readFileSync(join(dir, written[0] as string))]).toEqual([...bytes])
  })

  it('names the file after its media type, recovered from the bytes', async () => {
    // A `.png` holding JPEG bytes is a trap for every tool downstream. The type
    // cannot come from the clipboard — `getImage` returns bare bytes — so each
    // supported signature gets its own case; a test that only checked "some
    // extension" passed even when PNG was reported as JPEG.
    const cases: readonly [string, Uint8Array][] = [
      ['.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      ['.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0])],
      ['.webp', new Uint8Array([...new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])])],
      ['.gif', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])],
    ]
    for (const [extension, bytes] of cases) {
      const { clipboard } = reader({ image: bytes })
      const result = await pasteClipboard({ clipboard, directory: tempDir() })
      if (result.kind !== 'image') throw new Error(`expected an image result for ${extension}`)
      expect(result.text.endsWith(extension), `${extension} signature`).toBe(true)
    }
  })

  it('falls back to text', async () => {
    const { clipboard, calls } = reader({ text: 'hello from the clipboard' })
    const result = await pasteClipboard({ clipboard, directory: tempDir() })
    expect(result).toEqual({ kind: 'text', text: 'hello from the clipboard' })
    expect(calls).toEqual(['files', 'image', 'text'])
  })

  it('reports nothing to paste rather than an empty insert', async () => {
    // An empty clipboard must not look like a successful paste: the editor would
    // be unchanged and the user would think the key is broken.
    const { clipboard } = reader({})
    expect((await pasteClipboard({ clipboard, directory: tempDir() })).kind).toBe('empty')
  })

  it('treats an empty string as nothing, not as a successful paste', async () => {
    // Distinct from the case above: there the reader returned `null`, here it
    // returns `''` — a clipboard that *has* a text entry which happens to be empty.
    // Returning `{kind:'text', text:''}` would make the app insert nothing and then
    // report success, which is exactly the silent no-op this branch exists to avoid.
    const { clipboard } = reader({ text: '' })
    expect((await pasteClipboard({ clipboard, directory: tempDir() })).kind).toBe('empty')
  })
})

describe('pasteClipboard — refusals', () => {
  it('refuses a path containing control characters', async () => {
    // The path goes into the editor, and from there into a prompt. A newline in a
    // filename would silently turn one paste into two messages; other controls can
    // corrupt the frame. pi refuses the same case.
    const { clipboard } = reader({ files: ['/tmp/a\nrm -rf /'] })
    const result = await pasteClipboard({ clipboard, directory: tempDir() })
    expect(result.kind).toBe('error')
  })

  it('refuses an image whose bytes are no known type', async () => {
    // `getImage` returns bare bytes with no declared type, so the extension comes
    // from the signature. Writing these as `.png` would produce a file that lies
    // about its contents, and the decode error would surface much later with no
    // connection to the paste that caused it.
    const { clipboard } = reader({ image: new Uint8Array([0x42, 0x4d, 0x00, 0x00]) })
    const result = await pasteClipboard({ clipboard, directory: tempDir() })
    expect(result.kind).toBe('error')
  })

  it('reports an unavailable clipboard as such', async () => {
    // `undefined` from the reader means "no clipboard on this platform", which is
    // different from "the clipboard is empty": one is a limitation, the other is a
    // transient state, and a user deserves to know which.
    const result = await pasteClipboard({ clipboard: undefined, directory: tempDir() })
    expect(result.kind).toBe('unavailable')
  })
})

describe('control characters in pasted text', () => {
  /**
   * pi-tui's editor normalises line endings and tabs and **nothing else**, so an
   * `ESC` in pasted text reaches the composer verbatim and from there the prompt —
   * where it is re-interpreted by this program's own renderer and by anything
   * downstream that reads the transcript. Measured: `line1\nline2\\x00\\x1b[31mred`
   * came back out of `pasteClipboard` completely intact.
   *
   * The file-path branch already refuses this exact input. Text is the same hazard
   * arriving by a different channel, so it gets the same answer rather than a
   * different one.
   *
   * Newlines are **not** control characters here: a multi-line paste is a legitimate
   * thing to want, and the editor handles them.
   */
  it('refuses text carrying an escape sequence', async () => {
    const { clipboard } = reader({ text: 'safe\u001b[31mred' })
    expect((await pasteClipboard({ clipboard, directory: tempDir() })).kind).toBe('error')
  })

  it('refuses text carrying a NUL', async () => {
    const { clipboard } = reader({ text: 'a\u0000b' })
    expect((await pasteClipboard({ clipboard, directory: tempDir() })).kind).toBe('error')
  })

  it('accepts a multi-line paste', async () => {
    // The case the check must not break: newlines are the reason people paste.
    const { clipboard } = reader({ text: 'first\nsecond' })
    const result = await pasteClipboard({ clipboard, directory: tempDir() })
    expect(result).toEqual({ kind: 'text', text: 'first\nsecond' })
  })

  it('treats a newline in a *path* as an injection, but in text as normal', async () => {
    // The two branches look like the same check and are not, which is the trap for
    // whoever next decides to "deduplicate" them. In a path, `\n` splits one paste
    // into two submissions — the shape of a command injection. In text it is a
    // paragraph break, and refusing it would break the main use of the key.
    const asPath = await pasteClipboard({
      clipboard: reader({ files: ['/tmp/a\nrm -rf /'] }).clipboard,
      directory: tempDir(),
    })
    expect(asPath.kind).toBe('error')
    const asText = await pasteClipboard({
      clipboard: reader({ text: 'a\nrm -rf /' }).clipboard,
      directory: tempDir(),
    })
    expect(asText.kind).toBe('text')
  })
})
