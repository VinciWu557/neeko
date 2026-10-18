import { describe, expect, it, vi } from 'vitest'
import { Text } from '@earendil-works/pi-tui'
import { TuiApp } from '../src/tui/app.ts'
import { FakeTerminal } from './support/fake-terminal.ts'

/**
 * The interaction glue: keyboard → InteractionManager → panel, and editor
 * submit → answer.
 *
 * Three defects in two rounds all landed HERE, in the ~30 lines between a good
 * state machine (`tui-interactions.spec.ts`, 9 cases) and a working screen:
 *
 * 1. a pending free-text question's answer was sent to the MODEL and the
 *    question was never answered (agent hung forever);
 * 2. ESC cancelled approvals but did nothing on a question, so the only way out
 *    was quitting the TUI;
 * 3. `/clear` cleared the container, and the next repaint rebuilt the whole
 *    conversation from `rows`.
 *
 * Every case below drives the real seams (private `submit`, key routing, the
 * mounted containers) against a `FakeTerminal`, so no TTY is touched.
 */

type Seams = {
  app: TuiApp
  key: (data: string) => { consume?: boolean } | undefined
  submit: (text: string) => Promise<void>
  panel: () => string
  notices: () => string
  rows: () => number
}

function makeSeams(onSubmit = vi.fn()): Seams {
  const app = new TuiApp({
    getSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: '/tmp/test',
    getSessionId: () => 'session-test',
    onSubmit,
    onExit: () => {},
    version: '0.0.0-test',
    statusFacts: () => ({ cwd: '/tmp/test' }),
    modelPicker: async () => ({ models: [], current: '' }),
    selectModel: () => {},
    terminal: new FakeTerminal(),
  })
  const call = <T>(name: string, ...args: unknown[]): T => {
    const fn = (app as unknown as Record<string, ((...a: unknown[]) => T) | undefined>)[name]
    if (fn === undefined) throw new Error(`TuiApp has no method ${name}`)
    return fn.apply(app, args)
  }
  return {
    app,
    key: (data) => call('handleInput', data),
    submit: (text) => call('submit', text),
    panel: () => (app as unknown as { interactionText: { render(w: number): string[] } })
      .interactionText.render(120).join('\n').trim(),
    notices: () => (app as unknown as { notices: { children: { render(w: number): string[] }[] } })
      .notices.children.map((child) => child.render(200).join('\n')).join('\n'),
    rows: () => (app as unknown as { messages: { children: unknown[] } }).messages.children.length,
  }
}

/**
 * Open one approval and return its pending promise.
 *
 * NOT awaited before pressing a key: the promise settles only when the key is
 * routed, so awaiting it first is a deadlock (and was a 5s timeout here).
 */
function openApproval(app: TuiApp, toolName = 'bash'): Promise<string> {
  return app.interactions.approve({ toolName, reason: 'needs write' } as never) as Promise<string>
}

describe('approval key routing', () => {
  it('y allows, n rejects, esc cancels', async () => {
    const { app, key } = makeSeams()

    const allowed = openApproval(app)
    expect(key('y')).toEqual({ consume: true })
    await expect(allowed).resolves.toBe('allowed-once')

    const rejected = openApproval(app)
    key('n')
    await expect(rejected).resolves.toBe('rejected')

    const cancelled = openApproval(app)
    key('\x1b')
    await expect(cancelled).resolves.toBe('cancelled')
  })

  it('swallows unrelated keys instead of leaking them into the editor', async () => {
    const { app, key } = makeSeams()
    const pending = openApproval(app)
    // A stray character must not reach the editor while an approval is up.
    expect(key('h')).toEqual({ consume: true })
    expect(app.interactions.busy).toBe(true)
    key('y')
    await pending
  })

  it('renders the tool name, the reason and the key hints', async () => {
    const { app, panel } = makeSeams()
    void openApproval(app)
    const text = panel()
    expect(text).toContain('approve bash')
    expect(text).toContain('needs write')
    expect(text).toContain('[y] allow')
    expect(text).toContain('[esc] cancel')
  })

  it('clears the panel once the approval is settled', async () => {
    const { app, key, panel } = makeSeams()
    const pending = openApproval(app)
    expect(panel()).not.toBe('')
    key('y')
    await pending
    expect(panel()).toBe('')
  })
})

describe('question key routing', () => {
  const withOptions = (labels = ['Alpha', 'Beta']) => ({
    questions: [{ id: 'q1', question: 'Which one?', options: labels.map((label) => ({ label })) }],
  })
  const freeText = () => ({ questions: [{ id: 'q1', question: 'Your name?' }] })

  it('a digit picks that option', async () => {
    const { app, key } = makeSeams()
    const pending = app.interactions.ask(withOptions() as never)
    await Promise.resolve()
    key('2')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Beta'] }] })
  })

  it('a digit past the option list is swallowed, not treated as an answer', async () => {
    const { app, key } = makeSeams()
    const pending = app.interactions.ask(withOptions() as never)
    await Promise.resolve()
    expect(key('9')).toEqual({ consume: true })
    expect(app.interactions.busy).toBe(true)
    key('1')
    await pending
  })

  it('ESC cancels a question (regression: it used to do nothing at all)', async () => {
    const { app, key } = makeSeams()
    const pending = app.interactions.ask(withOptions() as never)
    await Promise.resolve()
    expect(key('\x1b')).toEqual({ consume: true })
    // Assert the CONTRACT (ASK_ABORTED code), not the wording — the message
    // distinguishes a user cancel from a teardown and may be reworded.
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(app.interactions.busy).toBe(false)
  })

  it('submitting a line ANSWERS a free-text question instead of prompting', async () => {
    // The original defect: the answer was sent to the model and the question
    // stayed pending, so the agent waited forever.
    const onSubmit = vi.fn()
    const { app, submit } = makeSeams(onSubmit)
    const pending = app.interactions.ask(freeText() as never)
    await Promise.resolve()

    await submit('Ada Lovelace')

    expect(onSubmit).not.toHaveBeenCalled()
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: 'Ada Lovelace' }] })
  })

  it('sends ordinary lines to the model again once the question is settled', async () => {
    const onSubmit = vi.fn()
    const { app, submit } = makeSeams(onSubmit)
    const pending = app.interactions.ask(freeText() as never)
    await Promise.resolve()
    await submit('the answer')
    await pending
    await submit('a real prompt')
    expect(onSubmit).toHaveBeenCalledWith('a real prompt')
  })

  it('renders the counter, the question and the numbered options', async () => {
    const { app, panel } = makeSeams()
    void app.interactions.ask({
      questions: [
        { id: 'q1', question: 'First?', options: [{ label: 'A' }] },
        { id: 'q2', question: 'Second?', options: [{ label: 'B' }] },
      ],
    } as never)
    await Promise.resolve()
    const text = panel()
    expect(text).toContain('(1/2)')
    expect(text).toContain('First?')
    expect(text).toContain('1. A')
  })

  it('advertises the editor for a free-text question', async () => {
    const { app, panel } = makeSeams()
    void app.interactions.ask(freeText() as never)
    await Promise.resolve()
    expect(panel()).toContain('type your answer, enter to submit')
  })
})

describe('/clear is a view operation that sticks', () => {
  it('stays cleared across a repaint and still shows new rows', async () => {
    // Regression: `clearTranscript` emptied the container only, and the next
    // flush rebuilt every row from `state.rows` — the conversation reappeared.
    const { app, submit, rows } = makeSeams()
    const state = { attachTime: 0, rows: [{ kind: 'user', content: 'old row' }] } as never
    app.mountTranscript(state)
    expect(rows()).toBe(1)

    await submit('/clear')
    expect(rows()).toBe(0)

    // A repaint (what any session event triggers) must not resurrect the row.
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(rows()).toBe(0)

    // Rows produced after the clear are new information and do appear.
    ;(state as { rows: unknown[] }).rows.push({ kind: 'user', content: 'new row' })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(rows()).toBe(1)
  })

  it('also drops the notice panel', async () => {
    const { app, submit, notices } = makeSeams()
    await submit('/help')
    expect(notices()).toContain('Commands:')
    await submit('/clear')
    expect(notices()).toBe('')
  })

  it('leaves the transcript rows themselves intact (the log is not the view)', async () => {
    const { app, submit } = makeSeams()
    const state = { attachTime: 0, rows: [{ kind: 'user', content: 'kept' }] } as never
    app.mountTranscript(state)
    await submit('/clear')
    expect((state as { rows: unknown[] }).rows).toHaveLength(1)
  })
})

describe('notices survive transcript repaints', () => {
  it('a command reply is not wiped by the next flush', async () => {
    const { app, submit, notices } = makeSeams()
    const state = { attachTime: 0, rows: [] } as never
    app.mountTranscript(state)
    await submit('/help')
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(notices()).toContain('Commands:')
  })

  it('is a separate container from the transcript', () => {
    const { app } = makeSeams()
    app.addMessage(new Text('notice'))
    const view = app as unknown as { messages: { children: unknown[] }; notices: { children: unknown[] } }
    expect(view.notices.children).toHaveLength(1)
    expect(view.messages.children).toHaveLength(0)
  })
})

describe('submit() guards the interaction invariant itself', () => {
  it('a pending APPROVAL swallows the submission instead of prompting', async () => {
    // Reachable via any submit path (and the guard belongs to `submit`, not to
    // the key router): the earlier version only handled questions, so an
    // approval let the line through to the model.
    const onSubmit = vi.fn()
    const { app, submit, notices } = makeSeams(onSubmit)
    const pending = app.interactions.approve({ toolName: 'bash', reason: undefined } as never)
    await submit('hello')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(app.interactions.busy).toBe(true)
    expect(notices()).toContain('answer the pending prompt first')
    app.interactions.cancelAll()
    await pending.catch(() => {})
  })

  it('clears the editor when a submission is refused', async () => {
    const { app, submit } = makeSeams()
    const pending = app.interactions.approve({ toolName: 'bash', reason: undefined } as never)
    await submit('/help')
    const editor = app as unknown as { editor: { getText(): string } }
    expect(editor.editor.getText()).toBe('')
    app.interactions.cancelAll()
    await pending.catch(() => {})
  })
})

describe('transcript watermark is reset by a new binding', () => {
  it('a re-bound shorter transcript renders its rows', async () => {
    // Regression: a leftover watermark (2) hid every row of a new, shorter
    // transcript, leaving the view permanently blank.
    const { app, submit, rows } = makeSeams()
    app.mountTranscript({ attachTime: 0, rows: [{ kind: 'user', content: 'a' }, { kind: 'user', content: 'b' }] } as never)
    await submit('/clear')
    expect(rows()).toBe(0)
    app.mountTranscript({ attachTime: 1, rows: [{ kind: 'user', content: 'new' }] } as never)
    expect(rows()).toBe(1)
  })
})

describe('notices are bounded', () => {
  it('drops the oldest replies instead of growing without limit', async () => {
    // `/help` alone appends a multi-line notice per keystroke, and every child
    // participates in every repaint.
    const { app, submit } = makeSeams()
    for (let i = 0; i < 200; i += 1) await submit('/help')
    const view = app as unknown as { notices: { children: unknown[] } }
    expect(view.notices.children.length).toBeLessThanOrEqual(64)
    expect(view.notices.children.length).toBeGreaterThan(0)
  })
})

describe('/model switch failures are visible', () => {
  it('reports a failure instead of rejecting silently', async () => {
    // Regression: an uncaught throw from the host-owned selectModel rejected the
    // submission with no notice, so pressing enter appeared to do nothing.
    const app = new TuiApp({
      getSelection: () => ({ provider: 'test', model: 'old' }),
      cwd: '/tmp/test',
      getSessionId: () => 'session-test',
      onSubmit: () => {},
      onExit: () => {},
      version: '0.0.0-test',
      statusFacts: () => ({ cwd: '/tmp/test' }),
      modelPicker: async () => ({
        models: [{ id: 'new', name: 'New', provider: 'test' }],
        current: 'test/old',
      }),
      selectModel: () => { throw new Error('save failed') },
      terminal: new FakeTerminal(),
    })
    const submit = (text: string): Promise<void> =>
      (app as unknown as { submit(t: string): Promise<void> }).submit.call(app, text)
    const rendered = (): string =>
      (app as unknown as { notices: { children: { render(w: number): string[] }[] } })
        .notices.children.map((child) => child.render(200).join('')).join('\n')

    await expect(submit('/model new')).resolves.toBeUndefined()
    expect(rendered()).toContain('model switch failed')
    expect(rendered()).not.toContain('model →')
  })

  it('still confirms a successful switch', async () => {
    const switched: string[] = []
    const app = new TuiApp({
      getSelection: () => ({ provider: 'test', model: 'old' }),
      cwd: '/tmp/test',
      getSessionId: () => 'session-test',
      onSubmit: () => {},
      onExit: () => {},
      version: '0.0.0-test',
      statusFacts: () => ({ cwd: '/tmp/test' }),
      modelPicker: async () => ({
        models: [{ id: 'new', name: 'New', provider: 'test' }],
        current: 'test/old',
      }),
      selectModel: (id) => { switched.push(id) },
      terminal: new FakeTerminal(),
    })
    const submit = (text: string): Promise<void> =>
      (app as unknown as { submit(t: string): Promise<void> }).submit.call(app, text)
    await submit('/model new')
    expect(switched).toEqual(['new'])
  })
})
