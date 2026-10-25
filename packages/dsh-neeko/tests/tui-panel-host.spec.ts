import { describe, expect, it, vi } from 'vitest'
import type { Component } from '@earendil-works/pi-tui'
import { PanelHost } from '../src/tui/panel-host.ts'
import type { KeyedComponent } from '../src/tui/panel-host.ts'

/**
 * The dock's single-occupant rule.
 *
 * ## What this replaces
 *
 * Three selectors each carried their own `Selector | undefined` field, their own
 * open/close pair and their own key forwarder. Three copies of one policy, and
 * they had already drifted in a way that was invisible until it bit:
 *
 * - The dock was left **empty** the first time a selector closed early, because
 *   `clear()` removed the four permanent rows and only the constructor put them
 *   back.
 * - Nothing stopped two "open" flags being set at once, so a key could be
 *   forwarded to a panel that had already been replaced by another.
 *
 * The invariant these tests pin is the second one: **at most one panel is open,
 * and it is the one the keys go to.**
 */

/** A panel that records the keys it received. */
function panel(name: string, keys: string[] = []): KeyedComponent & { name: string } {
  return {
    name,
    render: (): string[] => [name],
    invalidate: () => {},
    handleInput: (data: string) => { keys.push(data) },
  } as KeyedComponent & { name: string }
}

/**
 * Build a host over a recording dock.
 *
 * @returns the host and its observable state.
 */
function build(): {
  host: PanelHost
  children: () => readonly Component[]
  restores: () => number
  renders: () => number
} {
  let children: Component[] = []
  let restores = 0
  let renders = 0
  const dock = {
    clear: () => { children = [] },
    addChild: (component: Component) => { children.push(component) },
  }
  const host = new PanelHost({
    dock,
    restore: () => { restores += 1 },
    requestRender: () => { renders += 1 },
  })
  return {
    host,
    children: () => children,
    restores: () => restores,
    renders: () => renders,
  }
}

describe('PanelHost — the single occupant', () => {
  it('starts closed', () => {
    const { host } = build()
    expect(host.isOpen).toBe(false)
    expect(host.current).toBeUndefined()
  })

  it('mounts a panel and reports it open', () => {
    const context = build()
    const theme = panel('theme')
    context.host.show(theme)
    expect(context.host.isOpen).toBe(true)
    expect(context.host.current).toBe(theme)
    expect(context.children()).toEqual([theme])
  })

  it('replaces the panel instead of stacking a second one', () => {
    // `/theme` then `/thinking` is a legitimate sequence: the user changed their
    // mind. Two panels on one dock would share the keyboard and the rows.
    const context = build()
    const theme = panel('theme')
    const thinking = panel('thinking')
    context.host.show(theme)
    context.host.show(thinking)
    expect(context.children()).toEqual([thinking])
    expect(context.host.current).toBe(thinking)
  })

  it('restores the dock on close', () => {
    const context = build()
    context.host.show(panel('theme'))
    context.host.hide()
    expect(context.host.isOpen).toBe(false)
    expect(context.children()).toEqual([])
    expect(context.restores()).toBe(1)
  })

  it('is safe to close when nothing is open', () => {
    // Every close path calls this unconditionally (escape, select, teardown).
    const context = build()
    expect(() => context.host.hide()).not.toThrow()
    expect(context.restores()).toBe(1)
  })

  it('restores the dock after an early close, not only on a clean one', () => {
    // The defect three copies produced: the rows came back from the constructor
    // and nowhere else, so a selector that closed before the next construction
    // left the dock empty.
    const context = build()
    context.host.show(panel('theme'))
    context.host.hide()
    context.host.show(panel('thinking'))
    context.host.hide()
    expect(context.restores()).toBe(2)
  })

  it('repaints on every change', () => {
    const context = build()
    context.host.show(panel('theme'))
    context.host.hide()
    expect(context.renders()).toBe(2)
  })
})

describe('PanelHost — key routing', () => {
  it('forwards a key to the open panel', () => {
    const context = build()
    const keys: string[] = []
    context.host.show(panel('theme', keys))
    expect(context.host.handleKey('x')).toBe(true)
    expect(keys).toEqual(['x'])
  })

  it('forwards to the panel that replaced the first one', () => {
    // The reason state is one slot: with three parallel flags, the first panel's
    // flag stayed set and could receive a key it no longer owned.
    const context = build()
    const themeKeys: string[] = []
    const thinkingKeys: string[] = []
    context.host.show(panel('theme', themeKeys))
    context.host.show(panel('thinking', thinkingKeys))
    context.host.handleKey('x')
    expect(themeKeys).toEqual([])
    expect(thinkingKeys).toEqual(['x'])
  })

  it('declines when no panel is open', () => {
    // `false` is what lets the key fall through to the editor — a closed host that
    // reported "consumed" would make the input box dead.
    const context = build()
    expect(context.host.handleKey('x')).toBe(false)
  })

  it('declines again after the panel closes', () => {
    const context = build()
    context.host.show(panel('theme'))
    context.host.hide()
    expect(context.host.handleKey('x')).toBe(false)
  })
})
