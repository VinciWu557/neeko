import { describe, expect, it, vi } from 'vitest'
import { Text } from '@earendil-works/pi-tui'
import { TuiApp } from '../src/tui/app.ts'
import type { TuiAppOptions } from '../src/tui/app.ts'
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

function makeSeams(onSubmit = vi.fn(), extra: Partial<TuiAppOptions> = {}): Seams {
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
    ...extra,
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
    // The flush is driven explicitly: it no longer re-arms itself, so an idle
    // app must not repaint — that self-scheduling was the sluggishness.
    const seam = app as unknown as { scheduleRender?: () => void }
    seam.scheduleRender?.()
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(rows()).toBe(0)

    // Rows produced after the clear are new information and do appear.
    ;(state as { rows: unknown[] }).rows.push({ kind: 'user', content: 'new row' })
    seam.scheduleRender?.()
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

describe('/model opens a panel in place of the input area', () => {
  function makePanel(models: { id: string; name: string; provider: string }[], current: string): {
    app: TuiApp
    submit: (text: string) => Promise<void>
    panelScreen: (width?: number) => string
    hasPanel: () => boolean
    key: (data: string) => void
  } {
    const app = new TuiApp({
      getSelection: () => ({ provider: 'magpie', model: current }),
      cwd: '/tmp/test',
      getSessionId: () => 'session-test',
      onSubmit: () => {},
      onExit: () => {},
      version: '0.0.0-test',
      statusFacts: () => ({ cwd: '/tmp/test' }),
      modelPicker: async () => ({ models, current: `magpie/${current}` }),
      selectModel: () => {},
      terminal: new FakeTerminal(),
    })
    type Seams = {
      modelPanel?: { component: { render(w: number): string[] } }
      handleInput(d: string): unknown
      submit(t: string): Promise<void>
    }
    const seam = app as unknown as Seams
    return {
      app,
      submit: (text) => seam.submit.call(app, text),
      panelScreen: (width = 90) => seam.modelPanel === undefined
        ? ''
        : seam.modelPanel.component.render(width).join('\n').replace(/\x1b\[[0-9;]*m/gu, ''),
      hasPanel: () => seam.modelPanel !== undefined,
      key: (data) => { seam.handleInput.call(app, data) },
    }
  }

  it('shows the header, the catalogue and the key hint', async () => {
    const { submit, panelScreen, hasPanel } = makePanel([
      { id: 'group/auto-a', name: 'Model A', provider: 'magpie' },
      { id: 'ark/b', name: 'Model B', provider: 'ark' },
    ], 'group/auto-a')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await submit('/model')
    expect(hasPanel()).toBe(true)
    const screen = panelScreen()
    expect(screen).toContain('Only showing models from configured providers')
    expect(screen).toContain('group/auto-a')
    expect(screen).toContain('ark/b')
    expect(screen).toContain('Enter to select')
    expect(screen).toContain('Escape/Ctrl+C to cancel')
  })

  it('annotates each row with its provider and marks the current model', async () => {
    const { submit, panelScreen } = makePanel([
      { id: 'group/auto-a', name: 'Model A', provider: 'magpie' },
      { id: 'ark/b', name: 'Model B', provider: 'ark' },
    ], 'group/auto-a')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await submit('/model')
    const rows = panelScreen().split('\n')
    expect(rows.some((row) => row.includes('group/auto-a') && row.includes('✓'))).toBe(true)
    expect(panelScreen()).toContain('[magpie]')
    expect(panelScreen()).toContain('[ark]')
  })

  it('shows the highlighted model\'s name in the detail line', async () => {
    const { submit, panelScreen } = makePanel([
      { id: 'group/auto-a', name: 'Model A', provider: 'magpie' },
    ], 'group/auto-a')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await submit('/model')
    expect(panelScreen()).toContain('Model Name: Model A')
  })

  it('filters the catalogue as the user types', async () => {
    // A 195-model catalogue is only usable if typing narrows it.
    const { submit, panelScreen, key } = makePanel([
      { id: 'group/auto-a', name: 'A', provider: 'magpie' },
      { id: 'ark/b', name: 'B', provider: 'ark' },
    ], 'group/auto-a')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await submit('/model')
    key('a')
    key('r')
    key('k')
    const screen = panelScreen()
    expect(screen).toContain('ark/b')
    expect(screen).not.toContain('group/auto-a')
  })

  it('commits the highlighted model on Enter', async () => {
    const switched: string[] = []
    const app = new TuiApp({
      getSelection: () => ({ provider: 'magpie', model: 'group/auto-a' }),
      cwd: '/tmp/test',
      getSessionId: () => 'session-test',
      onSubmit: () => {},
      onExit: () => {},
      version: '0.0.0-test',
      statusFacts: () => ({ cwd: '/tmp/test' }),
      modelPicker: async () => ({
        models: [{ id: 'group/auto-a', name: 'A', provider: 'magpie' }],
        current: 'magpie/group/auto-a',
      }),
      selectModel: (id) => { switched.push(id) },
      terminal: new FakeTerminal(),
    })
    const seam = app as unknown as { submit(t: string): Promise<void>; handleInput(d: string): unknown }
    await new Promise((resolve) => setTimeout(resolve, 20))
    await seam.submit.call(app, '/model')
    seam.handleInput.call(app, '\r')
    // The switch is committed asynchronously (applyModelById validates the id
    // against the catalogue before calling back).
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(switched).toEqual(['group/auto-a'])
  })

  it('closes on Esc without switching', async () => {
    const switched: string[] = []
    const app = new TuiApp({
      getSelection: () => ({ provider: 'magpie', model: 'group/auto-a' }),
      cwd: '/tmp/test',
      getSessionId: () => 'session-test',
      onSubmit: () => {},
      onExit: () => {},
      version: '0.0.0-test',
      statusFacts: () => ({ cwd: '/tmp/test' }),
      modelPicker: async () => ({
        models: [{ id: 'group/auto-a', name: 'A', provider: 'magpie' }],
        current: 'magpie/group/auto-a',
      }),
      selectModel: (id) => { switched.push(id) },
      terminal: new FakeTerminal(),
    })
    const seam = app as unknown as {
      submit(t: string): Promise<void>; handleInput(d: string): unknown
      modelPanel?: unknown
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    await seam.submit.call(app, '/model')
    seam.handleInput.call(app, '\x1b')
    expect(seam.modelPanel).toBeUndefined()
    expect(switched).toEqual([])
  })

  it('occupies the editor slot instead of floating over the transcript', async () => {
    // The panel replaces the input surface, so it must be a direct child of the
    // screen in the editor's position — not an overlay composited on top.
    const { app, submit } = makePanel([{ id: 'group/a', name: 'A', provider: 'magpie' }], 'group/a')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await submit('/model')
    const seam = app as unknown as {
      tui: { children: { constructor: { name: string } }[] }
      editor: object
      modelPanel?: { component: object }
    }
    const names = seam.tui.children.map((child) => child.constructor.name)
    expect(names).toContain('Container')
    expect(seam.tui.children).toContain(seam.modelPanel?.component)
    expect(seam.tui.children).not.toContain(seam.editor)
  })

  it('puts the status bar last and only once', async () => {
    // `addChild` appends: without detaching first, every open would stack
    // another status bar.
    const { app, submit } = makePanel([{ id: 'group/a', name: 'A', provider: 'magpie' }], 'group/a')
    await new Promise((resolve) => setTimeout(resolve, 20))
    for (let i = 0; i < 3; i += 1) {
      await submit('/model')
      ;(app as unknown as { handleInput(d: string): unknown }).handleInput('\x1b')
    }
    const seam = app as unknown as {
      tui: { children: object[] }
      status: { component: object }
    }
    const occurrences = seam.tui.children.filter((child) => child === seam.status.component)
    expect(occurrences).toHaveLength(1)
    expect(seam.tui.children.at(-1)).toBe(seam.status.component)
  })

  it('restores the editor when cancelled', async () => {
    const { app, submit } = makePanel([{ id: 'group/a', name: 'A', provider: 'magpie' }], 'group/a')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await submit('/model')
    ;(app as unknown as { handleInput(d: string): unknown }).handleInput('\x1b')
    const seam = app as unknown as { tui: { children: object[] }; editor: object }
    expect(seam.tui.children).toContain(seam.editor)
  })

  it('reports a hard absence instead of opening an empty panel', async () => {
    const { submit, hasPanel } = makePanel([], '')
    await submit('/model')
    expect(hasPanel()).toBe(false)
  })
})

describe('ctrl+o expands and collapses the whole transcript', () => {
  /** A transcript with one tool row whose result body is the folded part. */
  function withToolRow(): { seams: Seams; state: { attachTime: number; rows: unknown[] } } {
    const seams = makeSeams()
    const state = {
      attachTime: 0,
      rows: [{
        kind: 'tool', taskId: 't1', name: 'bash',
        args: { command: 'ls' }, status: 'success',
        result: 'first result line\nsecond result line', turn: 1, images: [],
      }],
    }
    seams.app.mountTranscript(state as never)
    return { seams, state }
  }

  /** Render the mounted transcript to plain text. */
  const transcript = (seams: Seams): string =>
    (seams.app as unknown as { messages: { render(w: number): string[] } })
      .messages.render(120).join('\n').replace(/\x1b\[[0-9;]*m/gu, '').replace(/\x1b_pi:[^\\]*\\/gu, '')

  it('is folded before the key is pressed', () => {
    const { seams } = withToolRow()
    expect(transcript(seams)).not.toContain('second result line')
  })

  it('expands every row on the first press', async () => {
    // pi's `app.tools.expand` is a global switch (`setToolsExpanded` broadcasts
    // to every expandable child), not a per-row toggle.
    const { seams } = withToolRow()
    expect(seams.key('\x0f')).toEqual({ consume: true })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(transcript(seams)).toContain('second result line')
  })

  it('collapses everything again on the second press', async () => {
    const { seams } = withToolRow()
    seams.key('\x0f')
    await new Promise((resolve) => setTimeout(resolve, 120))
    seams.key('\x0f')
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(transcript(seams)).not.toContain('second result line')
  })

  it('invalidates the cached row components', async () => {
    // Regression guard: the fold state is part of `rowSignature()`. Left out,
    // the cache hits the old component and the key visibly does nothing.
    const { seams } = withToolRow()
    await new Promise((resolve) => setTimeout(resolve, 120))
    const before = (seams.app as unknown as { messages: { children: unknown[] } }).messages.children[0]
    seams.key('\x0f')
    await new Promise((resolve) => setTimeout(resolve, 120))
    const after = (seams.app as unknown as { messages: { children: unknown[] } }).messages.children[0]
    expect(after).not.toBe(before)
  })

  it('reports the new state as a notice', async () => {
    const { seams } = withToolRow()
    seams.key('\x0f')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(seams.notices()).toContain('expanded')
    seams.key('\x0f')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(seams.notices()).toContain('collapsed')
  })

  it('yields the keyboard to an open modal surface', async () => {
    // A pending approval owns every key; `ctrl+o` must not reach the transcript.
    const { seams } = withToolRow()
    const pending = openApproval(seams.app)
    seams.key('\x0f')
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(transcript(seams)).not.toContain('second result line')
    seams.app.interactions.cancelAll()
    await pending.catch(() => {})
  })
})

describe('status notices replace and expire', () => {
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('does not stack repeated status lines', async () => {
    // pi's `showStatus()` updates the previous status line in place rather than
    // appending, "to avoid log spam". Four `ctrl+o` presses must leave ONE line.
    const { app, key, notices } = makeSeams(vi.fn(), { statusNoticeMs: 10_000 })
    app.mountTranscript({ attachTime: 0, rows: [{ kind: 'user', content: 'a' }] } as never)
    key('\x0f')
    key('\x0f')
    key('\x0f')
    key('\x0f')
    await wait(60)
    const lines = notices().split('\n').map((l) => l.trim()).filter((l) => l !== '')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('transcript:')
  })

  it('shows the newest state, not the first one', async () => {
    const { app, key, notices } = makeSeams(vi.fn(), { statusNoticeMs: 10_000 })
    app.mountTranscript({ attachTime: 0, rows: [{ kind: 'user', content: 'a' }] } as never)
    key('\x0f') // expanded
    key('\x0f') // collapsed
    await wait(60)
    expect(notices()).toContain('collapsed')
    expect(notices()).not.toContain('expanded')
  })

  it('expires the status line instead of leaving it forever', async () => {
    // Reported by the user: the fold notices piled up and never went away.
    const { app, key, notices } = makeSeams(vi.fn(), { statusNoticeMs: 30 })
    app.mountTranscript({ attachTime: 0, rows: [{ kind: 'user', content: 'a' }] } as never)
    key('\x0f')
    expect(notices()).toContain('transcript:')
    await wait(120)
    expect(notices()).toBe('')
  })

  it('a second press restarts the countdown', async () => {
    const { app, key, notices } = makeSeams(vi.fn(), { statusNoticeMs: 60 })
    app.mountTranscript({ attachTime: 0, rows: [{ kind: 'user', content: 'a' }] } as never)
    key('\x0f')
    await wait(40)
    key('\x0f')
    await wait(40)
    // 80 ms have passed since the first press, but only 40 since the second.
    expect(notices()).toContain('transcript:')
    await wait(80)
    expect(notices()).toBe('')
  })

  it('keeps an error notice until the user clears it', async () => {
    // An error is an event, not a status: expiring it would hide the reason a
    // command failed. pi appends errors and warnings, never auto-clears them.
    const { submit, notices } = makeSeams(vi.fn(), { statusNoticeMs: 30 })
    await submit('/model does/not/exist')
    await wait(120)
    expect(notices()).toContain('no models available')
    await wait(80)
    expect(notices()).toContain('no models available')
  })

  it('a new status does not strand the previous component', async () => {
    // The expiring timer must clear the slot, not an arbitrary child: two
    // different statuses in a row leave the notices area empty, not one stale line.
    const { app, key, submit, notices } = makeSeams(vi.fn(), { statusNoticeMs: 30 })
    app.mountTranscript({ attachTime: 0, rows: [{ kind: 'user', content: 'a' }] } as never)
    key('\x0f')
    await wait(120)
    await submit('/help')
    expect(notices()).toContain('Commands:')
    await wait(80)
    // The fold status expired; the /help output (content, not status) remains.
    expect(notices()).not.toContain('transcript:')
    expect(notices()).toContain('Commands:')
  })

  it('stops the countdown when the app stops', async () => {
    // A live timer keeps the event loop alive, which would delay process exit.
    const { app, key } = makeSeams(vi.fn(), { statusNoticeMs: 10_000 })
    app.mountTranscript({ attachTime: 0, rows: [{ kind: 'user', content: 'a' }] } as never)
    key('\x0f')
    app.stop()
    const pending = (app as unknown as { statusTimer: unknown }).statusTimer
    expect(pending).toBeUndefined()
  })

  it('clears the status slot with the rest of the view', async () => {
    // A re-mounted line must be visible again (a stale slot would update text on
    // a component nobody sees), and the countdown must not be lost: with no
    // mounted line, a new status mounts a fresh one with a fresh timer.
    const { app, key, submit, notices } = makeSeams(vi.fn(), { statusNoticeMs: 30 })
    app.mountTranscript({ attachTime: 0, rows: [{ kind: 'user', content: 'a' }] } as never)
    key('\x0f')
    await wait(60)
    await submit('/clear')
    expect(notices()).toBe('')
    key('\x0f')
    expect(notices()).toContain('transcript:')
    await wait(120)
    expect(notices()).toBe('')
  })
})

describe('the status slot survives the notices bound', () => {
  it('does not keep updating an evicted status line', async () => {
    // `addMessage` drops the OLDEST child past `MAX_NOTICE_COMPONENTS`. When the
    // status line is what gets dropped, `showStatus` must mount a new one —
    // reusing the pointer would be a `setText()` nobody can see.
    const { app, key, submit, notices } = makeSeams(vi.fn(), { statusNoticeMs: 10_000 })
    app.mountTranscript({ attachTime: 0, rows: [{ kind: 'user', content: 'a' }] } as never)
    key('\x0f')
    for (let i = 0; i < 70; i += 1) await submit('/theme nope') // one error notice each
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(notices()).not.toContain('transcript:')
    key('\x0f')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(notices()).toContain('transcript:')
  })
})
