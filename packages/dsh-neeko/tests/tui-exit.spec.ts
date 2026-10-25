import { describe, expect, it } from 'vitest'
import { exitAfterFlush } from '../src/tui/runner.ts'

/**
 * Exiting without losing the final document.
 *
 * `process.stdout.write()` is asynchronous for a pipe/file. The alt screen's
 * `afterTerminalStop()` writes the **whole conversation** back to scrollback in
 * one go on quit — by far the largest write of the run — so calling
 * `process.exit()` right after it truncated exactly the thing the user keeps.
 * Measured on a real pty: the printed document was 1426 bytes (banner only)
 * instead of the banner plus the conversation.
 */

/** A writable stub that records what it was asked to do. */
function fakeStream(options: { drainImmediately: boolean } = { drainImmediately: true }) {
  const listeners: (() => void)[] = []
  let writable = true
  return {
    stream: {
      write(_chunk: string, callback?: (error?: Error | null) => void): boolean {
        // A callback fires once the chunk is handed to the OS.
        if (options.drainImmediately) queueMicrotask(() => { callback?.() })
        else listeners.push(() => { callback?.() })
        return true
      },
      once(event: string, listener: () => void): unknown {
        if (event === 'drain') listeners.push(listener)
        return this
      },
      get writableLength(): number { return writable ? 0 : 1 },
    },
    /** Simulate the OS finally accepting the buffered bytes. */
    flush(): void {
      writable = true
      for (const listener of listeners.splice(0)) listener()
    },
    setBackpressure(): void { writable = false },
  }
}

describe('exitAfterFlush', () => {
  it('exits only after the write callback fires', async () => {
    // The failure mode: `process.exit()` runs before the callback, so the bytes
    // never leave the buffer.
    const order: string[] = []
    const sink = fakeStream()
    await exitAfterFlush({
      stream: sink.stream,
      exit: (code) => { order.push(`exit:${code}`) },
      write: (done) => { order.push('write'); queueMicrotask(done) },
    })
    expect(order).toEqual(['write', 'exit:0'])
  })

  it('waits for the drain event when the stream is backed up', async () => {
    // A big final document can exceed the pipe buffer, and `write()` then
    // returns false; the bytes are still pending, so exiting there truncates.
    const order: string[] = []
    const sink = fakeStream()
    sink.setBackpressure()
    const done = exitAfterFlush({
      stream: sink.stream,
      exit: (code) => { order.push(`exit:${code}`) },
      write: (cb) => { order.push('write'); setTimeout(cb, 5) },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(['write'])
    sink.flush()
    await done
    expect(order).toEqual(['write', 'exit:0'])
  })

  it('exits anyway when the stream never acknowledges', async () => {
    // A TUI must not hang on quit: a broken/closed stdout must not keep the
    // process alive forever.
    const order: string[] = []
    await exitAfterFlush({
      stream: fakeStream().stream,
      exit: (code) => { order.push(`exit:${code}`) },
      write: () => {},
      timeoutMs: 20,
    })
    expect(order).toEqual(['exit:0'])
  })

  it('survives a stream that throws', async () => {
    const order: string[] = []
    await exitAfterFlush({
      stream: {
        once(): unknown { return this },
        writableLength: 0,
      },
      exit: (code) => { order.push(`exit:${code}`) },
      write: (done) => { done() },
    })
    expect(order).toEqual(['exit:0'])
  })
})
