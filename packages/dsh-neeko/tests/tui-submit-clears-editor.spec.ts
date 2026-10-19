import { describe, expect, it } from 'vitest'
import { TuiApp } from '../src/tui/app.ts'
import { FakeTerminal } from './support/fake-terminal.ts'

/**
 * The editor must be empty after every submission.
 *
 * pi-tui only opens the slash menu when `isAtStartOfMessage()` holds, which
 * requires the cursor to be on line 0 with nothing before it. `submit()` cleared
 * the buffer *after* the plain-message branch returned, so a normal message left
 * its text behind: the next `/` was typed into "hello", the menu stayed shut, and
 * it only appeared once another character moved the cursor. These cases pin the
 * invariant at the point where it broke.
 */

type EditorSeam = {
  setText(text: string): void
  getText(): string
  handleInput(data: string): void
  isShowingAutocomplete(): boolean
  state: { lines: string[]; cursorLine: number; cursorCol: number }
}

function makeApp(): { submit: (text: string) => Promise<void>; editor: EditorSeam } {
  const app = new TuiApp({
    getSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp/w',
    getSessionId: () => 's',
    onSubmit: () => {},
    onExit: () => {},
    version: '0',
    statusFacts: () => ({ cwd: '/tmp/w' }),
    modelPicker: async () => ({ models: [], current: '' }),
    selectModel: () => {},
    terminal: new FakeTerminal(),
  })
  const seam = app as unknown as { submit(t: string): Promise<void>; editor: EditorSeam }
  return { submit: (text) => seam.submit.call(app, text), editor: seam.editor }
}

const typeLine = (editor: EditorSeam, text: string): void => {
  for (const char of text) editor.handleInput(char)
}

describe('submit leaves an empty editor', () => {
  it('clears the buffer after a plain message', async () => {
    const { submit, editor } = makeApp()
    editor.setText('hello world')
    await submit('hello world')
    expect(editor.getText()).toBe('')
    expect(editor.state.cursorLine).toBe(0)
    expect(editor.state.cursorCol).toBe(0)
  })

  it('opens the slash menu on the very next keystroke', async () => {
    // The defect: `/` did nothing until another character was typed.
    const { submit, editor } = makeApp()
    editor.setText('a previous message')
    await submit('a previous message')
    editor.handleInput('/')
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(editor.isShowingAutocomplete()).toBe(true)
  })

  it('still opens the menu after a slash command', async () => {
    const { submit, editor } = makeApp()
    await submit('/help')
    editor.handleInput('/')
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(editor.isShowingAutocomplete()).toBe(true)
  })

  it('opens the menu on a fresh editor too', async () => {
    // The behaviour that already worked; kept so the fix cannot trade one path
    // for the other.
    const { editor } = makeApp()
    editor.handleInput('/')
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(editor.isShowingAutocomplete()).toBe(true)
  })

  it('keeps the submitted text when the buffer is multi-line', async () => {
    // A pasted multi-line prompt must still classify and clear like any other.
    const { submit, editor } = makeApp()
    typeLine(editor, 'line one')
    editor.handleInput('\n')
    typeLine(editor, 'line two')
    await submit(editor.getText())
    expect(editor.getText()).toBe('')
  })
})

describe('the editor repaints the live renderer', () => {
  /**
   * `Editor` captures its `tui` in the constructor and uses it for
   * `requestRender()` when the autocomplete menu opens. Fullscreen swaps the live
   * renderer, so a captured main screen would compute the rows and never show
   * them — the menu silently did nothing in fullscreen.
   */
  it('routes an autocomplete repaint to the fullscreen renderer', async () => {
    const app = new TuiApp({
      getSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp/w',
      getSessionId: () => 's',
      onSubmit: () => {},
      onExit: () => {},
      version: '0',
      statusFacts: () => ({ cwd: '/tmp/w' }),
      modelPicker: async () => ({ models: [], current: '' }),
      selectModel: () => {},
      terminal: new FakeTerminal({ columns: 100, rows: 40 }),
    })
    const seam = app as unknown as {
      submit(t: string): Promise<void>
      editor: EditorSeam
      fullscreen?: { screen: { requestRender(force?: boolean): void } }
    }
    await seam.submit.call(app, '/fullscreen')
    expect(seam.fullscreen).toBeDefined()

    let asked = 0
    const screen = seam.fullscreen?.screen
    if (screen !== undefined) screen.requestRender = () => { asked += 1 }
    seam.editor.handleInput('/')
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(asked).toBeGreaterThan(0)
  })
})
