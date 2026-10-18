import type { ProgramStatus, Terminal } from '@earendil-works/pi-tui'

/**
 * A `Terminal` that records output instead of writing to the developer's TTY.
 *
 * `TuiApp` takes a `Terminal` so the screen can be exercised against the real
 * pi-tui renderer in tests: without this, every repaint in a unit test dumps
 * raw ANSI into the reporter output (and mutates the terminal the test suite is
 * running in).
 */
export class FakeTerminal implements Terminal {
  /** Everything written through {@link write}, concatenated. */
  output = ''
  /** The input handler pi-tui registered, if the TUI was started. */
  onInput: ((data: string) => void) | undefined
  stopped = true

  constructor(private readonly size: { columns: number; rows: number } = { columns: 80, rows: 24 }) {}

  start(onInput: (data: string) => void): void {
    this.onInput = onInput
    this.stopped = false
  }

  stop(): void {
    this.stopped = true
  }

  drainInput(): Promise<void> {
    return Promise.resolve()
  }

  write(data: string): void {
    this.output += data
  }

  get columns(): number {
    return this.size.columns
  }

  get rows(): number {
    return this.size.rows
  }

  get kittyProtocolActive(): boolean {
    return false
  }

  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(_status: ProgramStatus): void {}
}
