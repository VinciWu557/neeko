import { describe, expect, it } from 'vitest'
import { readSessionEvents } from '../src/dsh-adapter.ts'

/**
 * Regression origin: `session.init` was built from `agent.session.events`, which
 * does not exist on the 0.2.0-rc.2 `Session`. The first `dsh-agent` handshake
 * died with `TypeError: events is not iterable` ("fatal load failure"), so the
 * chat never opened even after the bridge started listening.
 *
 * dsh-session 0.2.0-rc.2 exposes `snapshotEvents()` for a full-log read (its
 * synchronous `events` property is gone). These cases pin the adapter to the
 * API that actually exists, and pin the fallback so a future rename fails loudly
 * here instead of crashing the whole bridge at runtime.
 */
describe('readSessionEvents', () => {
  it('reads the log through snapshotEvents()', () => {
    const events = [{ type: 'a' }, { type: 'b' }]
    const session = { snapshotEvents: () => events }
    expect(readSessionEvents(session)).toEqual(events)
  })

  it('returns an empty log when the session has no readable events', () => {
    expect(readSessionEvents({})).toEqual([])
  })

  it('does not depend on a legacy `events` property', () => {
    // A session carrying only the removed property must not be treated as valid.
    const session = { events: [{ type: 'legacy' }] }
    expect(readSessionEvents(session)).toEqual([])
  })

  it('survives a throwing reader instead of crashing the caller', () => {
    const session = { snapshotEvents: () => { throw new Error('boom') } }
    expect(readSessionEvents(session)).toEqual([])
  })
})
