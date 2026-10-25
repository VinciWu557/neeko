import { describe, expect, it, vi } from 'vitest'
import { Text } from '@earendil-works/pi-tui'
import { NoticeLog } from '../src/tui/notice-log.ts'

/**
 * The notices area: durable replies plus one self-clearing status line.
 *
 * Extracted from `TuiApp` because it owns state of its own (which line is the
 * transient one, when it expires) and because every caller — `/help`, an error,
 * a `ctrl+o` confirmation — was reaching into the app to append a component.
 *
 * The contract worth pinning is the *bounds*: notices are user-triggerable
 * without limit, and one status line must never become a stack.
 */

/** A NoticeLog wired to a fake clock. */
function makeLog(over: { max?: number; statusMs?: number } = {}) {
  const repaints = { count: 0 }
  const log = new NoticeLog({
    ...(over.max === undefined ? {} : { max: over.max }),
    ...(over.statusMs === undefined ? {} : { statusMs: over.statusMs }),
    paint: (token, text) => `<${token}>${text}</${token}>`,
    onChange: () => { repaints.count += 1 },
  })
  return { log, repaints }
}

/** Every notice line, flattened. */
const text = (log: NoticeLog): string =>
  log.container.children.map((child) => child.render(200).join('\n')).join('\n')

describe('NoticeLog bounds', () => {
  it('drops the oldest notice past the limit', () => {
    // `/help` alone appends eight lines per press, so an unbounded list grows
    // both memory and per-frame cost for the whole session.
    const { log } = makeLog({ max: 3 })
    for (let i = 0; i < 5; i += 1) log.add(new Text(`line ${i}`))
    expect(log.container.children).toHaveLength(3)
    expect(text(log)).not.toContain('line 0')
    expect(text(log)).toContain('line 4')
  })

  it('renders a durable notice in its tone', () => {
    const { log } = makeLog()
    log.notice('boom', 'error')
    expect(text(log)).toContain('<error>boom</error>')
  })

  it('defaults the tone to plain text', () => {
    const { log } = makeLog()
    log.notice('hello')
    expect(text(log)).toContain('<text>hello</text>')
  })
})

describe('NoticeLog status line', () => {
  it('reuses one line instead of appending a second', () => {
    // pi keeps exactly one status line for this reason: a stack of stale
    // "transcript: expanded" lines is what the slot exists to prevent.
    const { log } = makeLog()
    log.status('first')
    log.status('second')
    expect(log.container.children).toHaveLength(1)
    expect(text(log)).toContain('second')
    expect(text(log)).not.toContain('first')
  })

  it('expires on its own', async () => {
    vi.useFakeTimers()
    try {
      const { log } = makeLog({ statusMs: 100 })
      log.status('temporary')
      expect(text(log)).toContain('temporary')
      vi.advanceTimersByTime(101)
      expect(log.container.children).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts the countdown on every call', async () => {
    vi.useFakeTimers()
    try {
      const { log } = makeLog({ statusMs: 100 })
      log.status('one')
      vi.advanceTimersByTime(80)
      log.status('two')
      // 80 ms into the first window: the line must still be there because the
      // second call restarted it.
      vi.advanceTimersByTime(80)
      expect(text(log)).toContain('two')
      vi.advanceTimersByTime(30)
      expect(log.container.children).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('remounts after the bounded trim dropped it', () => {
    // The trim can evict the status line (it is often the oldest child), and
    // updating an unmounted component is a `setText()` nobody can see.
    const { log } = makeLog({ max: 2 })
    log.status('status')
    log.add(new Text('a'))
    log.add(new Text('b'))
    log.status('after trim')
    expect(text(log)).toContain('after trim')
  })

  it('clears both the line and its countdown', () => {
    vi.useFakeTimers()
    try {
      const { log } = makeLog({ statusMs: 100 })
      log.status('gone')
      log.clearStatus()
      expect(log.container.children).toHaveLength(0)
      // A surviving timer would fire on an already-cleared slot.
      vi.advanceTimersByTime(500)
      expect(log.container.children).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('announces every change so the owner can repaint', () => {
    const { log, repaints } = makeLog()
    log.notice('a')
    log.status('b')
    log.clearStatus()
    expect(repaints.count).toBe(3)
  })

  it('clears everything, status line included', () => {
    // `/clear` is a view operation: rows and the session log are untouched, but
    // what is on screen has to go — including the transient line, whose pointer
    // would otherwise outlive its component.
    const { log } = makeLog()
    log.notice('durable')
    log.status('transient')
    log.clear()
    expect(log.container.children).toHaveLength(0)
    // A later status still works: the pointer was dropped with the container.
    log.status('fresh')
    expect(text(log)).toContain('fresh')
  })
})
