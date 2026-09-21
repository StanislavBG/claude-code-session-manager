// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentLibrary } from '../AgentLibrary'
import { useSessions } from '../../../state/sessions'
import { __resetModelCatalogForTests } from '../../../lib/useModelCatalog'
import type { AgentPersona } from '../../../../preload/api'

type Detail = NonNullable<AgentPersona['overrideDetails']>[number]

function persona(details: Detail[] = []): AgentPersona {
  return {
    name: 'dev-lead', description: 'd', tools: [], model: 'sonnet', effort: null, color: null,
    tags: [], projects: [], action: null, actionLabel: null, path: '/x/dev-lead.md', body: 'b',
    overridingProjects: details.map((d) => d.project), overrideDetails: details,
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let savePersona: ReturnType<typeof vi.fn>
let removeOverride: ReturnType<typeof vi.fn>

async function mount(details: Detail[], activeCwd: string | null) {
  savePersona = vi.fn().mockResolvedValue({ ok: true, path: '' })
  removeOverride = vi.fn().mockResolvedValue({ ok: true })
  ;(window as unknown as { api: unknown }).api = {
    agents: {
      listPersonas: vi.fn().mockResolvedValue([persona(details)]),
      savePersona, deletePersona: vi.fn(), removeOverride,
      onChanged: vi.fn(() => () => {}),
    },
    app: { homeDir: vi.fn().mockResolvedValue('/home/bilko') },
    config: { listDir: vi.fn().mockResolvedValue([]), readText: vi.fn().mockResolvedValue(''), exists: vi.fn().mockResolvedValue(false) },
    models: undefined, // catalog === null → static option lists
  }
  useSessions.setState({
    tabs: activeCwd ? [{ id: 't1', cwd: activeCwd } as never] : [],
    activeTabId: activeCwd ? 't1' : null,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(AgentLibrary))
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
  return container
}

const within = (el: HTMLElement, testid: string, text: string) =>
  Array.from(el.querySelector(`[data-testid="${testid}"]`)!.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement
const click = async (b: HTMLElement) => {
  await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })
}

beforeEach(() => __resetModelCatalogForTests())
afterEach(() => {
  act(() => root?.unmount())
  container?.remove(); container = null; root = null
  useSessions.setState({ tabs: [], activeTabId: null })
  delete (window as unknown as { api?: unknown }).api
})

describe('AgentLibrary project override', () => {
  it('hides the editor with an explanation when there is no active project', async () => {
    const el = await mount([], null)
    expect(el.querySelector('[data-testid="project-override"]')).toBeNull()
    expect(el.querySelector('[data-testid="project-override-none"]')!.textContent).toContain('No active project')
  })

  it('setting a project model writes a project-scoped overlay call, never a global one', async () => {
    const el = await mount([], '/work/alpha')
    await click(within(el, 'override-model-row', 'opus'))
    expect(savePersona).toHaveBeenCalledTimes(1)
    expect(savePersona.mock.calls[0][0]).toMatchObject({ name: 'dev-lead', projectName: 'alpha', model: 'opus', effort: 'inherit' })
  })

  it('adding effort keeps the existing model and sends the effort', async () => {
    const el = await mount([{ project: 'alpha', fields: ['model'], values: { model: 'opus' }, bodyOverridden: false, issue: null }], '/work/alpha')
    await click(within(el, 'override-effort-row', 'high'))
    expect(savePersona.mock.calls[0][0]).toMatchObject({ projectName: 'alpha', model: 'opus', effort: 'high' })
  })

  it('clearing both goes through removeOverride, not savePersona', async () => {
    const el = await mount([{ project: 'alpha', fields: ['model'], values: { model: 'opus' }, bodyOverridden: false, issue: null }], '/work/alpha')
    await click(within(el, 'override-model-row', 'use global'))
    expect(removeOverride).toHaveBeenCalledWith({ name: 'dev-lead', projectName: 'alpha' })
    expect(savePersona).not.toHaveBeenCalled()
  })

  it('a full-body overlay is flagged and its pickers are disabled (never converted)', async () => {
    const el = await mount([{ project: 'alpha', fields: ['model'], values: { model: 'haiku' }, bodyOverridden: true, issue: null }], '/work/alpha')
    expect(el.querySelector('[data-testid="project-override-fullbody"]')).toBeTruthy()
    const b = within(el, 'override-model-row', 'opus')
    expect(b.matches(':disabled')).toBe(true)
    await click(b)
    expect(savePersona).not.toHaveBeenCalled()
  })

  it('renders provenance as global → project', async () => {
    const el = await mount([{ project: 'alpha', fields: ['model'], values: { model: 'claude-opus-4-6' }, bodyOverridden: false, issue: null }], '/work/alpha')
    const t = el.querySelector('[data-testid="override-provenance-model"]')!.textContent!
    expect(t).toContain('sonnet')
    expect(t).toContain('claude-opus-4-6')
    expect(t.indexOf('sonnet')).toBeLessThan(t.indexOf('claude-opus-4-6'))
    expect(el.querySelector('[data-testid="override-provenance-effort"]')!.textContent).toContain('not overridden')
  })

  it('the global model row keeps writing the global persona (no projectName)', async () => {
    const el = await mount([], '/work/alpha')
    await click(within(el, 'model-row', 'opus'))
    const save = Array.from(el.querySelectorAll('button')).find((b) => /^save$/i.test(b.textContent ?? ''))!
    await click(save)
    expect(savePersona.mock.calls[0][0].projectName).toBeUndefined()
  })
})
