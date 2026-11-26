// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentLibrary } from '../AgentLibrary'
import { __resetModelCatalogForTests } from '../../../lib/useModelCatalog'
import type { AgentPersona } from '../../../../preload/api'

// The real pane mounts Tiptap/Monaco; the stub keeps the contract this page relies on:
// controlled body text, Document mode by default, and the status bar's Save/Revert.
vi.mock('../editor/DocumentEditorPane', () => ({
  DocumentEditorPane: (p: { path: string; value: string; defaultMode?: string; dirty?: boolean; onChange: (v: string) => void; onSave?: () => void; onRevert?: () => void }) =>
    createElement('div', { 'data-testid': 'document-editor-pane', 'data-mode': p.defaultMode, 'data-path': p.path }, [
      createElement('textarea', { key: 'ta', 'data-testid': 'document-editor-body', value: p.value, onChange: (e: { target: { value: string } }) => p.onChange(e.target.value) }),
      createElement('button', { key: 'r', 'data-testid': 'editor-revert', disabled: !p.dirty, onClick: () => p.onRevert?.() }, 'Revert'),
      createElement('button', { key: 's', 'data-testid': 'editor-save', disabled: !p.dirty, onClick: () => p.onSave?.() }, 'Save'),
    ]),
}))

const CATALOG = {
  aliases: ['sonnet', 'opus', 'haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]', 'opusplan', 'default'],
  models: ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  effortLevels: [], settingsEffortLevels: [], availableModels: null as string[] | null,
  claudeVersion: '2.0.0', probedAt: null,
  sources: { aliases: 'probe', models: 'binary', effortLevels: 'probe' },
  degraded: false,
}

function persona(model: string | null, effort: string | null = null): AgentPersona {
  return { effort,
    name: 'p', description: 'd', tools: [], model, color: null,
    tags: [], projects: [], action: null, actionLabel: null,
    path: '/x/p.md', body: 'b', overridingProjects: [],
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let savePersona: ReturnType<typeof vi.fn>
let catalogFn: ReturnType<typeof vi.fn> | undefined

async function mount(model: string | null, catalog: unknown, effort: string | null = null) {
  savePersona = vi.fn().mockResolvedValue({ ok: true, path: '' })
  catalogFn = catalog === undefined ? undefined : vi.fn().mockResolvedValue(catalog)
  ;(window as unknown as { api: unknown }).api = {
    agents: {
      listPersonas: vi.fn().mockResolvedValue([persona(model, effort)]),
      savePersona,
      deletePersona: vi.fn(), removeOverride: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    app: { homeDir: vi.fn().mockResolvedValue('/home/bilko') },
    config: {
      listDir: vi.fn().mockResolvedValue([]),
      readText: vi.fn().mockResolvedValue(''),
      exists: vi.fn().mockResolvedValue(false),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    models: catalogFn ? { catalog: catalogFn } : undefined,
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(AgentLibrary))
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
  // The roster is the landing; open the first persona's sheet like the old auto-selection did.
  await act(async () => {
    container!.querySelector<HTMLElement>('[data-testid="agent-card"]')?.click()
    await Promise.resolve()
  })
  return container
}

const sel = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLSelectElement
const opts = (s: HTMLSelectElement) => Array.from(s.options)
const labels = (s: HTMLSelectElement) => opts(s).map((o) => o.textContent)
const group = (s: HTMLSelectElement, label: string) =>
  Array.from((s.querySelector(`optgroup[label="${label}"]`) ?? document.createElement('optgroup')).querySelectorAll('option')).map((o) => o.textContent)
const pick = async (s: HTMLSelectElement, v: string) => {
  await act(async () => { s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve() })
}
const click = async (b: HTMLElement | undefined) => {
  await act(async () => { b!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })
}
const saveClick = async (el: HTMLElement) => click(el.querySelector('[data-testid="editor-save"]') as HTMLElement)

beforeEach(() => __resetModelCatalogForTests())
afterEach(() => {
  act(() => root?.unmount())
  container?.remove(); container = null; root = null
  delete (window as unknown as { api?: unknown }).api
})

describe('AgentLibrary model select', () => {
  it('lists catalog aliases (incl. [1m], best, opusplan, default) instead of the static list', async () => {
    const el = await mount(null, CATALOG)
    const aliases = group(sel(el, 'model-select'), 'Aliases')
    for (const a of ['inherit', 'best', 'opus[1m]', 'opusplan', 'default']) expect(aliases).toContain(a)
    expect(sel(el, 'model-select').value).toBe('inherit')
  })

  it('pinned versions list every concrete id plus the suffixed variants of suffixed aliases', async () => {
    const el = await mount('opus', CATALOG)
    const pinned = group(sel(el, 'model-select'), 'Pinned versions')
    expect(pinned).toEqual(expect.arrayContaining(['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-opus-5[1m]', 'claude-sonnet-5[1m]']))
    expect(pinned).not.toContain('claude-haiku-4-5-20251001[1m]')
  })

  it('picking a version pins the exact id', async () => {
    const el = await mount('opus', CATALOG)
    await pick(sel(el, 'model-select'), 'claude-opus-4-8')
    await saveClick(el)
    expect(savePersona.mock.calls[0][0].model).toBe('claude-opus-4-8')
  })

  it('a pinned id shows selected and picking the alias restores the bare alias', async () => {
    const el = await mount('claude-opus-4-8', CATALOG)
    expect(sel(el, 'model-select').value).toBe('claude-opus-4-8')
    await pick(sel(el, 'model-select'), 'opus')
    await saveClick(el)
    expect(savePersona.mock.calls[0][0].model).toBe('opus')
  })

  it('an alias containing [1m] is saved verbatim', async () => {
    const el = await mount('opus', CATALOG)
    await pick(sel(el, 'model-select'), 'opus[1m]')
    await saveClick(el)
    expect(savePersona.mock.calls[0][0].model).toBe('opus[1m]')
  })

  it('disables (not hides) options outside availableModels with an explanatory title', async () => {
    const el = await mount('opus', { ...CATALOG, availableModels: ['opus'] })
    const o = (v: string) => opts(sel(el, 'model-select')).find((x) => x.value === v)!
    expect(o('haiku').disabled).toBe(true)
    expect(o('haiku').title).toMatch(/allowlist/)
    expect(o('opus').disabled).toBe(false)
    expect(o('claude-opus-4-8').disabled).toBe(false)
    expect(o('claude-sonnet-5').disabled).toBe(true)
  })

  it('null catalog falls back to the static five; the ⋯ menu says the catalog is unavailable', async () => {
    const el = await mount(null, null)
    const l = labels(sel(el, 'model-select'))
    for (const a of ['inherit', 'haiku', 'sonnet', 'opus', 'fable']) expect(l).toContain(a)
    expect(l).not.toContain('best')
    await click(el.querySelector('[data-testid="agent-detail-more"]') as HTMLElement)
    expect(el.querySelector('[data-testid="agent-detail-catalog-info"]')!.textContent).toContain('catalog unavailable')
  })

  it('an unlisted stored value stays selected and is not rewritten on save', async () => {
    const el = await mount('claude-opus-3-retired', CATALOG)
    expect(labels(sel(el, 'model-select'))).toContain('claude-opus-3-retired (current)')
    expect(sel(el, 'model-select').value).toBe('claude-opus-3-retired')
    expect(savePersona).not.toHaveBeenCalled()
  })

  it('the help text rides on the select title; the ⋯ menu shows the CLI version and Re-check forces a catalog re-read', async () => {
    const el = await mount('opus', CATALOG)
    expect(sel(el, 'model-select').title).toContain("This persona's default model")
    await click(el.querySelector('[data-testid="agent-detail-more"]') as HTMLElement)
    expect(el.querySelector('[data-testid="agent-detail-catalog-info"]')!.textContent).toContain('claude 2.0.0')
    await click(el.querySelector('[data-testid="agent-detail-recheck"]') as HTMLElement)
    expect(catalogFn!.mock.calls.at(-1)![0]).toMatchObject({ force: true })
  })
})

const EFFORT_CATALOG = {
  ...CATALOG,
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
  settingsEffortLevels: ['low', 'medium', 'high', 'xhigh'],
}
const effortLabels = (el: HTMLElement) => labels(sel(el, 'effort-select'))

describe('AgentLibrary effort select', () => {
  it('lists inherit + catalog effortLevels with a session-only marker; the hint is the title', async () => {
    const el = await mount('opus', EFFORT_CATALOG)
    expect(effortLabels(el)).toEqual(['inherit', 'low', 'medium', 'high', 'xhigh', 'max (session-only)', 'auto (session-only)'])
    expect(sel(el, 'effort-select').title).toContain('max, auto are session-only')
  })

  it('null catalog falls back to the static list', async () => {
    const el = await mount('opus', null)
    expect(effortLabels(el)).toEqual(['inherit', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('an unlisted stored value stays selected', async () => {
    const el = await mount('opus', EFFORT_CATALOG, 'ludicrous')
    expect(effortLabels(el)).toContain('ludicrous (current)')
    expect(sel(el, 'effort-select').value).toBe('ludicrous')
  })

  it('picking a level saves it', async () => {
    const el = await mount('opus', EFFORT_CATALOG)
    await pick(sel(el, 'effort-select'), 'high')
    await saveClick(el)
    expect(savePersona.mock.calls[0][0].effort).toBe('high')
  })

  it('notes (without disabling) when the selected model does not support effort', async () => {
    const el = await mount('haiku', EFFORT_CATALOG, 'high')
    expect(el.querySelector('[data-testid="effort-unsupported-note"]')).toBeTruthy()
    expect(sel(el, 'effort-select').disabled).toBe(false)
  })

  it('no note for a supporting model', async () => {
    const el = await mount('claude-opus-4-8', EFFORT_CATALOG, 'high')
    expect(el.querySelector('[data-testid="effort-unsupported-note"]')).toBeNull()
  })
})
