import { describe, expect, it } from 'vitest'
import { Container, Text } from '@earendil-works/pi-tui'
import { rowSignature, syncChildren } from '../src/tui/row-cache.ts'
import { TranscriptFold } from '../src/tui/fold.ts'
import type { TranscriptRow } from '../src/tui/transcript.ts'

/**
 * The two pieces of the repaint pipeline that need no app state.
 *
 * Extracted from `TuiApp.mountTranscript`'s flush, which mixes them with theme
 * projection, image prefetching and renderer calls. Both are pure: one decides
 * whether a row's component can be reused, the other reconciles a container.
 *
 * They matter because the flush runs every 50 ms for a whole session. A
 * signature that misses a change shows stale rows; one that changes too eagerly
 * throws away the cache the flush exists to use.
 */

const fold = new TranscriptFold()

const tool = (over: Partial<Extract<TranscriptRow, { kind: 'tool' }>> = {}): TranscriptRow => ({
  kind: 'tool', taskId: 't', name: 'bash', args: {}, status: 'running',
  result: undefined, turn: 1, images: [], ...over,
})

const assistant = (over: Partial<Extract<TranscriptRow, { kind: 'assistant' }>> = {}): TranscriptRow => ({
  kind: 'assistant', turn: 1, step: 1, attemptId: 'a', text: '', thinking: '', done: false, ...over,
})

const SIGN = (row: TranscriptRow, over: Partial<Parameters<typeof rowSignature>[0]> = {}): string =>
  rowSignature({
    row,
    themeName: 'dark',
    fold,
    attachTime: 0,
    ...over,
  })

describe('rowSignature — changes that must rebuild the row', () => {
  it('differs between themes', () => {
    // A theme switch repaints every string.
    expect(SIGN(tool(), { themeName: 'light' })).not.toBe(SIGN(tool()))
  })

  it('differs when the fold state changes', () => {
    const row = tool()
    fold.toggle(row)
    const expanded = SIGN(row)
    fold.toggle(row)
    expect(expanded).not.toBe(SIGN(row))
  })

  it('differs while a reply is streaming', () => {
    // `text.length` moves on every token, which is exactly when the row has to be
    // rebuilt — a signature that missed this would freeze a streaming answer.
    expect(SIGN(assistant({ text: 'a' }))).not.toBe(SIGN(assistant({ text: 'ab' })))
    expect(SIGN(assistant({ thinking: 'a' }))).not.toBe(SIGN(assistant({ thinking: 'ab' })))
  })

  it('does NOT differ for an animation frame', () => {
    // The frame used to be an input, so every 80 ms tick rebuilt the streaming row
    // — a fresh `Markdown`, a fresh parse, five times a second. The glyph is gone
    // now and the one animation owner is `Loader` in the composer's border, so
    // there is nothing left to tick.
    expect(SIGN(assistant({ text: 'x' }), { themeName: 'dark' }))
      .toBe(SIGN(assistant({ text: 'x' }), { themeName: 'dark' }))
  })

  it('differs when a tool result arrives', () => {
    expect(SIGN(tool({ result: 'out', status: 'success' }))).not.toBe(SIGN(tool()))
  })

  it('differs as a tool result grows', () => {
    // A result can arrive in pieces; a signature that only looked at the status
    // would keep the first, shorter body on screen.
    expect(SIGN(tool({ result: 'a', status: 'success' })))
      .not.toBe(SIGN(tool({ result: 'ab', status: 'success' })))
  })

  it('differs when a tool gains an image', () => {
    const image = { attachmentId: 'i', mediaType: 'image/png', base64: '' }
    expect(SIGN(tool({ images: [image] }))).not.toBe(SIGN(tool()))
  })

  it('differs when the attach time changes', () => {
    // A restored transcript re-uses row objects with a new attach time; the ids
    // are rendered relative to it, so the rows must be rebuilt.
    expect(SIGN(tool(), { attachTime: 1_000 })).not.toBe(SIGN(tool()))
  })

  it('differs when a user row grows', () => {
    const user = (content: string): TranscriptRow => ({ kind: 'user', messageId: 'u', content })
    expect(SIGN(user('a'))).not.toBe(SIGN(user('ab')))
  })
})

describe('rowSignature — changes that must NOT rebuild the row', () => {
  it('is stable for an unchanged tool row', () => {
    // The cache is what makes a 50 ms flush affordable; an eager signature would
    // rebuild every row on every tick.
    const row = tool({ result: 'same', status: 'success' })
    expect(SIGN(row)).toBe(SIGN(row))
  })

  it('is stable for a finished reply', () => {
    const row = assistant({ text: 'done', done: true })
    expect(SIGN(row)).toBe(SIGN(row))
  })

  it('does not depend on the rendered content of a failure', () => {
    // A failure row is written once and never mutated, so its length is enough.
    const row: TranscriptRow = { kind: 'failure', turn: 1, text: 'boom' }
    expect(SIGN(row)).toBe(SIGN(row))
  })
})

describe('syncChildren', () => {
  it('adds missing children', () => {
    const container = new Container()
    const a = new Text('a')
    syncChildren(container, [a])
    expect(container.children).toEqual([a])
  })

  it('removes children that are no longer wanted', () => {
    const container = new Container()
    const [a, b] = [new Text('a'), new Text('b')]
    container.addChild(a)
    container.addChild(b)
    syncChildren(container, [a])
    expect(container.children).toEqual([a])
  })

  it('keeps the identity of unchanged children', () => {
    // Matching by index keeps the array's identity, so the flush touches only
    // the slots that differ. `clear()` + re-`addChild` would rebuild all of it.
    const container = new Container()
    const [a, b] = [new Text('a'), new Text('b')]
    container.addChild(a)
    container.addChild(b)
    syncChildren(container, [a, b])
    expect(container.children[0]).toBe(a)
    expect(container.children[1]).toBe(b)
  })

  it('replaces a child that changed in place', () => {
    const container = new Container()
    const [before, after] = [new Text('before'), new Text('after')]
    container.addChild(before)
    syncChildren(container, [after])
    expect(container.children).toEqual([after])
  })

  it('handles a shrink to nothing', () => {
    const container = new Container()
    container.addChild(new Text('a'))
    syncChildren(container, [])
    expect(container.children).toHaveLength(0)
  })

  it('handles a mixed add, replace and drop in one pass', () => {
    const container = new Container()
    const [keep, drop] = [new Text('keep'), new Text('drop')]
    container.addChild(keep)
    container.addChild(drop)
    const added = new Text('added')
    syncChildren(container, [keep, added])
    expect(container.children).toEqual([keep, added])
  })
})
