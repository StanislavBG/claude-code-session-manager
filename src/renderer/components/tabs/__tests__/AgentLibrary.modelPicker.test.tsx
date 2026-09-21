// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentLibrary } from '../AgentLibrary'
import { __resetModelCatalogForTests } from '../../../lib/useModelCatalog'
import type { AgentPersona } from '../../../../preload/api'

const CATALOG = {
  aliases: ['sonnet', 'opus', 'haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]', 'opusplan', 'default'],
  models: ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  effortLevels: [], settingsEffortLevels: [], availableModels: null as string[] | null,
  claudeVersion: '2.0.0', probedAt: null,
  sources: { aliases: 'probe', models: 'binary', effortLevels: 'probe' },
  degraded: false,
}

function persona(model: string | null): AgentPersona {
  return {
    name: 'p', description: 'd', tools: [], model, color: null,
    tags: [], projects: [], action: null, actionLabel: null,
    path: '/x/p.md', body: 'b', overridingProjects: [],
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let savePersona: ReturnType<typeof vi.fn>
let catalogFn: ReturnType<typeof vi.fn> | undefined

async function mount(model: string | null, catalog: unknown) {
  savePersona = vi.fn().mockResolvedValue({ ok: true, path: '' })
  catalogFn = catalog === undefined ? undefined : vi.fn().mockResolvedValue(catalog)
  ;(window as unknown as { api: unknown }).api = {
    agents: {
      listPersonas: vi.fn().mockResolvedValue([persona(model)]),
      savePersona,
      deletePersona: vi.fn(), removeOverride: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    app: { homeDir: vi.fn().mockResolvedValue('/home/bilko') },
    config: { listDir: vi.fn().mockResolvedValue([]), readText: vi.fn().mockResolvedValue(''), exists: vi.fn().mockResolvedValue(false) },
    models: catalogFn ? { catalog: catalogFn } : undefined,
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(AgentLibrary))
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
  return container
}

const btn = (el: HTMLElement, text: string) =>
  Array.from(el.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement | undefined
const click = async (b: HTMLElement | undefined) => {
  await act(async () => { b!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })
}
const saveClick = async (el: HTMLElement) => click(Array.from(el.querySelectorAll('button')).find((b) => /^save$/i.test(b.textContent ?? '')))

beforeEach(() => __resetModelCatalogForTests())
afterEach(() => {
  act(() => root?.unmount())
  container?.remove(); container = null; root = null
  delete (window as unknown as { api?: unknown }).api
})

describe('AgentLibrary model picker', () => {
  it('renders catalog aliases (incl. [1m], best, opusplan, default) instead of the static list', async () => {
    const el = await mount(null, CATALOG)
    for (const a of ['inherit', 'best', 'opus[1m]', 'opusplan', 'default']) expect(btn(el, a)).toBeTruthy()
  })

  it('version row filters by family and hides for inherit', async () => {
    const el = await mount('opus', CATALOG)
    const row = el.querySelector('[data-testid="model-version-row"]')!
    const labels = Array.from(row.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toEqual(['latest', 'claude-opus-5', 'claude-opus-4-8'])
    await click(btn(el, 'inherit'))
    expect(el.querySelector('[data-testid="model-version-row"]')).toBeNull()
  })

  it('picking a version pins the exact id', async () => {
    const el = await mount('opus', CATALOG)
    await click(btn(el, 'claude-opus-4-8'))
    await saveClick(el)
    expect(savePersona.mock.calls[0][0].model).toBe('claude-opus-4-8')
  })

  it('latest restores the bare alias', async () => {
    const el = await mount('claude-opus-4-8', CATALOG)
    expect(btn(el, 'opus')!.className).toContain('accent')
    await click(btn(el, 'latest'))
    await saveClick(el)
    expect(savePersona.mock.calls[0][0].model).toBe('opus')
  })

  it('an alias containing [1m] is saved verbatim', async () => {
    const el = await mount('opus', CATALOG)
    await click(btn(el, 'opus[1m]'))
    await saveClick(el)
    expect(savePersona.mock.calls[0][0].model).toBe('opus[1m]')
  })

  it('disables (not hides) options outside availableModels with an explanatory title', async () => {
    const el = await mount('opus', { ...CATALOG, availableModels: ['opus'] })
    const b = btn(el, 'haiku')!
    expect(b.disabled).toBe(true)
    expect(b.title).toMatch(/allowlist/)
    expect(btn(el, 'opus')!.disabled).toBe(false)
  })

  it('null catalog falls back to the static five with a note', async () => {
    const el = await mount(null, null)
    for (const a of ['inherit', 'haiku', 'sonnet', 'opus', 'fable']) expect(btn(el, a)).toBeTruthy()
    expect(btn(el, 'best')).toBeUndefined()
    expect(el.textContent).toContain('catalog unavailable')
  })

  it('an unlisted stored value stays selected and is not rewritten on save', async () => {
    const el = await mount('claude-opus-3-retired', CATALOG)
    expect(btn(el, 'claude-opus-3-retired (current)')).toBeTruthy()
    // Alias row is not silently reset, and a save with no edit is not offered / does not rewrite it.
    expect(savePersona).not.toHaveBeenCalled()
  })

  it('refresh forces a catalog re-read', async () => {
    const el = await mount('opus', CATALOG)
    await click(el.querySelector('[data-testid="model-catalog-refresh"]') as HTMLElement)
    expect(catalogFn!.mock.calls.at(-1)![0]).toMatchObject({ force: true })
  })
})
