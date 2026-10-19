import { describe, expect, it, vi } from 'vitest'
import { matchesKey } from '@earendil-works/pi-tui'
import {
  MODEL_PANEL_MAX_VISIBLE, buildModelPanel, handleModelPanelKey, modelPanelTheme, modelRowItem,
} from '../src/tui/model-panel.ts'
import { findBuiltin, resolveTheme } from '../src/tui/theme.ts'

/**
 * The `/model` panel: a header, a filter box, the catalogue, the highlighted
 * row's name and a key hint, standing in for the input area (pi's `openPicker`
 * shape).
 *
 * These cases pin the parts pi's own list provides but the vendored `SelectList`
 * does not: the header line, search-as-you-type, and the detail line.
 */

const theme = resolveTheme(findBuiltin('dark')!)
const plain = (lines: readonly string[]): string =>
  lines.join('\n').replace(/\x1b\[[0-9;]*m/gu, '')

const models = [
  { id: 'group/auto-a', name: 'Model A', provider: 'magpie', isCurrent: true },
  { id: 'ark/code', name: 'Ark Code', provider: 'ark-coding-plan', isDefault: true },
  { id: 'glm/5', name: 'GLM 5.3', provider: 'ark-coding-plan' },
]

const make = (onSelect = vi.fn(), onCancel = vi.fn()) => ({
  onSelect,
  onCancel,
  panel: buildModelPanel({ models, theme, onSelect, onCancel }),
})

const key = (data: string) => (name: string): boolean => matchesKey(data, name as never)

describe('modelRowItem', () => {
  it('marks the model in effect with a check', () => {
    expect(modelRowItem(models[0]!).label).toBe('✓ group/auto-a')
    expect(modelRowItem(models[2]!).label).toBe('glm/5')
  })

  it('annotates the provider and the default marker', () => {
    expect(modelRowItem(models[0]!).description).toBe('[magpie]')
    expect(modelRowItem(models[1]!).description).toBe('[ark-coding-plan] · default')
  })
})

describe('buildModelPanel', () => {
  it('renders the header, every row, the detail and the hint', () => {
    const { panel } = make()
    // The filter box uses pi-tui's fake-cursor markers, which the real TUI
    // consumes; they are stripped here so assertions read the layout.
    const text = plain(panel.component.render(90)).replace(/\x1b_pi:[^\\]*\\/gu, '')
    expect(text).toContain('Only showing models from configured providers. Use /login to add providers.')
    expect(text).toContain('group/auto-a')
    expect(text).toContain('ark/code')
    expect(text).toContain('glm/5')
    expect(text).toContain('Model Name: Model A')
    expect(text).toContain('Enter to select')
    expect(text).toContain('Escape/Ctrl+C to cancel')
  })

  it('windows a long catalogue instead of rendering every row', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, name: `M${i}`, provider: 'p' }))
    const panel = buildModelPanel({ models: many, theme, onSelect: () => {}, onCancel: () => {} })
    const lines = plain(panel.component.render(90)).split('\n')
    // 200 models must not become 200 rows.
    expect(lines.length).toBeLessThan(MODEL_PANEL_MAX_VISIBLE + 12)
    // …and the count is still reported so the user knows the list is truncated.
    expect(lines.some((line) => /\(\d+\/\d+\)/u.test(line))).toBe(true)
  })

  it('defaults to the ten rows pi shows', () => {
    expect(MODEL_PANEL_MAX_VISIBLE).toBe(10)
  })

  it('shows the human name of the highlighted row, not of the first', () => {
    const { panel } = make()
    handleModelPanelKey(panel, '\x1b[B', key('\x1b[B'))
    expect(plain(panel.component.render(90))).toContain('Model Name: Ark Code')
  })
})

describe('handleModelPanelKey', () => {
  it('filters as the user types', () => {
    const { panel } = make()
    for (const char of 'ark') handleModelPanelKey(panel, char, key(char))
    const text = plain(panel.component.render(90))
    expect(text).toContain('ark/code')
    expect(text).not.toContain('glm/5')
  })

  it('commits the highlighted row on Enter', () => {
    const { panel, onSelect } = make()
    handleModelPanelKey(panel, '\r', key('\r'))
    expect(onSelect).toHaveBeenCalledWith('group/auto-a')
  })

  it('cancels on Esc without selecting', () => {
    const { panel, onSelect, onCancel } = make()
    handleModelPanelKey(panel, '\x1b', key('\x1b'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('moves the selection with the arrows', () => {
    const { panel, onSelect } = make()
    handleModelPanelKey(panel, '\x1b[B', key('\x1b[B'))
    handleModelPanelKey(panel, '\r', key('\r'))
    expect(onSelect).toHaveBeenCalledWith('ark/code')
  })

  it('reports every key as handled so nothing leaks to the hidden editor', () => {
    const { panel } = make()
    for (const data of ['a', '\r', '\x1b', '\x1b[A']) {
      expect(handleModelPanelKey(panel, data, key(data))).toBe(true)
    }
  })
})

describe('fuzzy search', () => {
  const catalogue = [
    { id: 'group/auto-step-5-preview', name: 'Step 5', provider: 'magpie' },
    { id: 'workbuddy-ai/deepseek-v4.1-flash', name: 'DeepSeek', provider: 'magpie' },
    { id: 'group/auto-qfmodel', name: 'QF', provider: 'magpie' },
  ]

  const type = (panel: ReturnType<typeof buildModelPanel>, query: string): void => {
    for (const char of query) handleModelPanelKey(panel, char, key(char))
  }

  it('matches characters in order, not just as a prefix', () => {
    // `step5` is in the middle of `group/auto-step-5-preview`: a prefix filter
    // would report no match.
    const panel = buildModelPanel({ models: catalogue, theme, onSelect: () => {}, onCancel: () => {} })
    type(panel, 'step5')
    const text = plain(panel.component.render(120))
    expect(text).toContain('group/auto-step-5-preview')
    expect(text).not.toContain('group/auto-qfmodel')
  })

  it('finds an acronym across separators', () => {
    const panel = buildModelPanel({ models: catalogue, theme, onSelect: () => {}, onCancel: () => {} })
    type(panel, 'wbds')
    const text = plain(panel.component.render(120))
    expect(text).toContain('workbuddy-ai/deepseek-v4.1-flash')
    expect(text).not.toContain('group/auto-qfmodel')
  })

  it('restores the whole catalogue when the query is cleared', () => {
    const panel = buildModelPanel({ models: catalogue, theme, onSelect: () => {}, onCancel: () => {} })
    type(panel, 'step5')
    for (let i = 0; i < 5; i += 1) handleModelPanelKey(panel, '\x7f', key('\x7f'))
    const text = plain(panel.component.render(120))
    expect(text).toContain('group/auto-step-5-preview')
    expect(text).toContain('workbuddy-ai/deepseek-v4.1-flash')
    expect(text).toContain('group/auto-qfmodel')
  })

  it('ranks the best match first so Enter picks it', () => {
    const picked = vi.fn()
    const panel = buildModelPanel({ models: catalogue, theme, onSelect: picked, onCancel: () => {} })
    type(panel, 'step5')
    handleModelPanelKey(panel, '\r', key('\r'))
    expect(picked).toHaveBeenCalledWith('group/auto-step-5-preview')
  })

  it('does not truncate a long model id', () => {
    // The list's default primary column is 32 cells, which cuts
    // `workbuddy-ai/deepseek-v4.1-flash` short and hides which model is meant.
    const panel = buildModelPanel({
      models: [{ id: 'workbuddy-ai/deepseek-v4.1-flash', name: 'D', provider: 'magpie' }],
      theme,
      onSelect: () => {},
      onCancel: () => {},
    })
    expect(plain(panel.component.render(120))).toContain('workbuddy-ai/deepseek-v4.1-flash')
  })
})

describe('Ctrl+S writes the default', () => {
  it('reports the row it was asked to default, with its provider', () => {
    const reported: { provider: string; id: string }[] = []
    const panel = buildModelPanel({
      models,
      theme,
      onSelect: () => {},
      onCancel: () => {},
      onSetDefault: (model) => { reported.push({ provider: model.provider, id: model.id }) },
    })
    handleModelPanelKey(panel, '\x13', key('\x13'))
    expect(reported).toEqual([{ provider: 'magpie', id: 'group/auto-a' }])
  })

  it('confirms in the panel without closing it', () => {
    const panel = buildModelPanel({
      models, theme, onSelect: () => {}, onCancel: () => {}, onSetDefault: () => {},
    })
    handleModelPanelKey(panel, '\x13', key('\x13'))
    expect(plain(panel.component.render(90))).toContain('Model catalogs refreshed.')
  })

  it('does nothing when the owner wired no handler', () => {
    const { panel } = make()
    expect(handleModelPanelKey(panel, '\x13', key('\x13'))).toBe(true)
    expect(plain(panel.component.render(90))).not.toContain('Model catalogs refreshed.')
  })
})

describe('catalogue shape', () => {
  it('lists models from every configured provider, not just the active one', () => {
    // Switching provider is the panel's point: scoping the rows to the active
    // route would hide every alternative.
    const multi = [
      { id: 'group/auto-a', name: 'A', provider: 'magpie' },
      { id: 'ark-code-latest', name: 'Ark', provider: 'ark-coding-plan' },
    ]
    const panel = buildModelPanel({ models: multi, theme, onSelect: () => {}, onCancel: () => {} })
    const text = plain(panel.component.render(90))
    expect(text).toContain('[magpie]')
    expect(text).toContain('[ark-coding-plan]')
  })

  it('marks the profile default separately from the current model', () => {
    // A row can be the default without being in effect, so the two markers
    // must not collapse into one.
    const rows = [
      modelRowItem({ id: 'a', name: 'A', provider: 'p', isCurrent: true }),
      modelRowItem({ id: 'b', name: 'B', provider: 'p', isDefault: true }),
    ]
    expect(rows[0]!.label).toBe('✓ a')
    expect(rows[0]!.description).toBe('[p]')
    expect(rows[1]!.label).toBe('b')
    expect(rows[1]!.description).toBe('[p] · default')
  })
})

describe('modelPanelTheme', () => {
  it('colors every slot from the active palette', () => {
    const t = modelPanelTheme(theme)
    for (const fn of [t.selectedPrefix, t.selectedText, t.description, t.scrollInfo, t.noMatch]) {
      expect(typeof fn('x')).toBe('string')
    }
  })
})
