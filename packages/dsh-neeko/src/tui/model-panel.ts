/**
 * The `/model` panel: a full-height picker that takes over the input area.
 *
 * ## Shape
 *
 * ```
 * Only showing models from configured providers.
 * ┌ filter ─────────────────────┐
 * │                              │
 * → ✓ group/auto-step-5-preview [magpie] · default
 *   ark-code-latest            [ark-coding-plan]
 *   …
 *   (1/195)
 * Model Name: Step-5-Preview · routing group
 * Enter to select · Esc to cancel
 * ```
 *
 * ## Why not the editor's inline completion, and why not a centred overlay
 *
 * - **Inline completion** only offers candidates for the text being typed and
 *   cannot carry a search box, a selection detail line or a key-hint footer.
 * - **A centred overlay** floats over the conversation, which reads as a
 *   transient dialog rather than the main surface.
 *
 * pi's own picker replaces the input area entirely (`openPicker` builds a
 * `SelectList` with `enableSearch`/`header`/`showHint`). The vendored pi-tui
 * `SelectList` has no such options, so the pieces are composed here: a header
 * line, an `Input` used as the filter box, the `SelectList`, a detail line for
 * the highlighted row, and a hint footer. The result is mounted through
 * `showOverlay` anchored to the bottom, so it occupies the editor's place.
 *
 * @module dsh-neeko/tui/model-panel
 */

import { Container } from '@earendil-works/pi-tui'
import { Input } from '@earendil-works/pi-tui'
import { SelectList, fuzzyFilter } from '@earendil-works/pi-tui'
import { Text } from '@earendil-works/pi-tui'
import type { OverlayHandle, SelectItem, SelectListTheme } from '@earendil-works/pi-tui'
import type { Theme } from './theme.ts'

/** One selectable model, as the panel renders it. */
export interface ModelRow {
  readonly id: string
  readonly name: string
  readonly provider: string
  /** This is the model currently in effect. */
  readonly isCurrent?: boolean
  /** This is the provider's default model. */
  readonly isDefault?: boolean
}

/** Rows visible before the list scrolls (pi shows ten). */
export const MODEL_PANEL_MAX_VISIBLE = 10

/**
 * The list palette, derived from the active theme.
 * @param theme - the active theme.
 * @returns a `SelectListTheme` for this panel.
 */
export function modelPanelTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg('accent', text),
    selectedText: (text) => theme.fg('accent', text),
    description: (text) => theme.fg('dim', text),
    scrollInfo: (text) => theme.fg('dim', text),
    noMatch: (text) => theme.fg('dim', text),
  }
}

/**
 * Build the visible row for one model.
 *
 * `✓` marks the model in effect and `default` the provider default — the same
 * two markers pi's picker uses, so a row answers "which one am I on" and "which
 * one would the provider pick" without extra lines.
 *
 * @param model - the catalogue entry.
 * @returns the `SelectItem` to feed the list.
 */
export function modelRowItem(model: ModelRow): SelectItem {
  const markers = [`[${model.provider}]`]
  if (model.isDefault === true) markers.push('default')
  return {
    value: model.id,
    label: model.isCurrent === true ? `✓ ${model.id}` : model.id,
    description: markers.join(' · '),
  }
}

/** What the panel needs from the app. */
export interface ModelPanelOptions {
  readonly models: readonly ModelRow[]
  readonly theme: Theme
  readonly onSelect: (id: string) => void
  readonly onCancel: () => void
  /** `Ctrl+S`: write the highlighted model as the profile default. */
  readonly onSetDefault?: ((model: ModelRow) => void) | undefined
  /** Rows rendered at once; defaults to {@linkcode MODEL_PANEL_MAX_VISIBLE}. */
  readonly maxVisible?: number
}

/** The mounted panel. */
export interface ModelPanel {
  /** The component to hand to `showOverlay`. */
  readonly component: Container
  /** The list, so the owner can drive it (focus, filtering). */
  readonly list: SelectList
  /** The filter box; keeps focus so typing narrows the list. */
  readonly filter: Input
  /** Overlay handle; the owner assigns it right after showing the component. */
  readonly overlay: { handle: OverlayHandle | undefined }
  /** Re-read the detail line after the selection moved. */
  refreshDetail(): void
  /** Narrow the rows to `query` (fuzzy, ranked). */
  applyFilter(query: string): void
  /** Show a one-line confirmation (`Model catalogs refreshed.`). */
  report(text: string): void
  /** `Ctrl+S` handler, when the owner wired one. */
  readonly onSetDefault: ((model: ModelRow) => void) | undefined
  /** The row currently highlighted, if any. */
  selectedModel(): ModelRow | undefined
}

/**
 * Assemble the panel.
 *
 * The filter box owns the keyboard: every keystroke goes to it, and the list is
 * filtered from its value — that is what makes a 195-model catalogue usable. The
 * list still receives navigation keys (arrows / enter / escape), routed by
 * {@linkcode ModelPanel.handleKey}.
 *
 * @param options - catalogue, theme and callbacks.
 * @returns the mounted panel.
 */
export function buildModelPanel(options: ModelPanelOptions): ModelPanel {
  const { models, theme, onSelect, onCancel, onSetDefault } = options
  const maxVisible = options.maxVisible ?? MODEL_PANEL_MAX_VISIBLE

  const root = new Container()
  const header = new Text(theme.fg('warning',
    'Only showing models from configured providers. Use /login to add providers.'))
  const filter = new Input({ prompt: '> ' })
  const list = new SelectList(models.map(modelRowItem), maxVisible, modelPanelTheme(theme), {
    // Default is 32 columns, which truncates real model ids
    // (`workbuddy-ai/deepseek-v4.1-flash` is 33). Let the id claim what it needs.
    maxPrimaryColumnWidth: 48,
  })
  const detail = new Text('')
  const status = new Text('')
  const hint = new Text(theme.fg('dim',
    'Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel'))

  const byId = new Map(models.map((model) => [model.id, model]))
  const allRows = models.map(modelRowItem)

  /**
   * Narrow the list with pi-tui's fuzzy matcher.
   *
   * `SelectList.setFilter` compares with `startsWith`, which cannot express what
   * a model picker needs: `step5` should find `group/auto-step-5-preview` and
   * `wbds` should find `workbuddy-ai/deepseek-v4.1-flash`. `fuzzyFilter` also
   * ranks, so the best match is the row the cursor lands on.
   *
   * `items` is a runtime field on the vendored class (no `setItems` exists), so
   * it is replaced wholesale and `setFilter('')` resets the filtered view.
   */
  const applyFilter = (query: string): void => {
    const matched = fuzzyFilter(allRows, query, (item) => item.value)
    // Keep the list's own state in sync: it filters `items` by prefix, so the
    // already-fuzzy-filtered set is handed over with an empty query.
    ;(list as unknown as { items: typeof allRows }).items = matched
    list.setFilter('')
    refreshDetail()
  }

  /** The row currently highlighted, if any. */
  const selectedModel = (): ModelRow | undefined => {
    const selected = list.getSelectedItem()
    return selected === null ? undefined : byId.get(selected.value)
  }

  /** Show the highlighted row's human name under the list. */
  const refreshDetail = (): void => {
    const selected = list.getSelectedItem()
    const model = selected === null ? undefined : byId.get(selected.value)
    detail.setText(model === undefined ? '' : theme.fg('dim', `Model Name: ${model.name}`))
  }

  list.onSelect = (item) => { onSelect(item.value) }
  list.onCancel = () => { onCancel() }
  filter.onEscape = () => { onCancel() }
  filter.onSubmit = () => {
    const selected = list.getSelectedItem()
    if (selected !== null) onSelect(selected.value)
  }

  root.addChild(header)
  root.addChild(filter)
  root.addChild(list)
  root.addChild(detail)
  root.addChild(status)
  root.addChild(hint)
  refreshDetail()

  const overlay: { handle: OverlayHandle | undefined } = { handle: undefined }

  /** Write one transient confirmation under the detail line. */
  const report = (text: string): void => { status.setText(theme.fg('success', text)) }

  return {
    component: root,
    list,
    filter,
    overlay,
    refreshDetail,
    applyFilter,
    report,
    selectedModel,
    onSetDefault,
  }
}

/**
 * Route one key to the filter box or the list.
 *
 * The filter owns printable input; the list owns navigation and commit keys.
 * Returning `true` means the key was consumed by the panel.
 *
 * @param panel - the mounted panel.
 * @param data - the raw key data.
 * @param isKey - predicate for named keys (`escape`, `enter`, `up`, `down`).
 * @returns whether the key was handled.
 */
export function handleModelPanelKey(
  panel: ModelPanel,
  data: string,
  isKey: (name: 'escape' | 'enter' | 'up' | 'down' | 'ctrl+s') => boolean,
): boolean {
  if (isKey('escape')) {
    panel.list.onCancel?.()
    return true
  }
  if (isKey('ctrl+s')) {
    const model = panel.selectedModel()
    if (model !== undefined && panel.onSetDefault !== undefined) {
      panel.onSetDefault(model)
      panel.report('Model catalogs refreshed.')
    }
    return true
  }
  if (isKey('enter')) {
    const selected = panel.list.getSelectedItem()
    if (selected !== null) panel.list.onSelect?.(selected)
    return true
  }
  if (isKey('up') || isKey('down')) {
    panel.list.handleInput(data)
    panel.refreshDetail()
    return true
  }
  // Everything else is filter text: feed the box, then narrow the list.
  panel.filter.handleInput(data)
  panel.applyFilter(panel.filter.getValue())
  return true
}
