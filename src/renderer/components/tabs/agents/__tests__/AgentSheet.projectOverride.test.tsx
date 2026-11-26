// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentLibrary } from '../../AgentLibrary'
import { useSessions } from '../../../../state/sessions'
import { toast } from '../../../../state/toast'
import { __resetModelCatalogForTests } from '../../../../lib/useModelCatalog'
import type { AgentPersona } from '../../../../../preload/api'

vi.mock('../../../../lib/uiSettingsPrefs', () => ({
  readUiSettingsPrefs: async () => ({ agentsListExpanded: true }),
  writeUiSettingsPrefs: async () => {},
}))
vi.mock('../../editor/DocumentEditorPane', () => ({
  DocumentEditorPane: () => createElement('div', { 'data-testid': 'document-editor-pane' }),
}))

type Detail = NonNullable<AgentPersona['overrideDetails']>[number]
const detail = (cwd: string, fields: string[], values: Record<string, string>, bodyOverridden = false): Detail => ({
  project: cwd.split('/').filter(Boolean).pop()!, cwd, fields, values, bodyOverridden, issue: null,
})
function persona(details: Detail[] = []): AgentPersona {
  return {
    name: 'dev-lead', description: 'd', tools: ['Read', 'Grep'], model: 'sonnet', effort: null, color: null,
    tags: [], projects: [], action: null, actionLabel: null, path: '/x/dev-lead.md', body: 'b',
    overridingProjects: details.map((d) => d.project), overrideDetails: details,
    ...({ loadout: 'equipped' } as object),
  } as AgentPersona
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let savePersona: ReturnType<typeof vi.fn>
let removeOverride: ReturnType<typeof vi.fn>
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

async function mount(details: Detail[], cwds: string[]) {
  savePersona = vi.fn().mockResolvedValue({ ok: true, path: '' })
  removeOverride = vi.fn().mockResolvedValue({ ok: true })
  ;(window as unknown as { api: unknown }).api = {
    agents: {
      listPersonas: vi.fn().mockResolvedValue([persona(details)]),
      armory: vi.fn().mockResolvedValue({ builtins: [], bundledSkills: [], mcpServers: [], packs: [], unpackedSkills: [], errors: [] }),
      savePersona, deletePersona: vi.fn(), removeOverride, onChanged: vi.fn(() => () => {}),
    },
    app: { homeDir: vi.fn().mockResolvedValue('/home/bilko') },
    config: {
      listDir: vi.fn().mockResolvedValue([]), readText: vi.fn().mockResolvedValue(''), exists: vi.fn().mockResolvedValue(false),
      watch: vi.fn(), unwatch: vi.fn(), onChanged: vi.fn(() => () => {}),
    },
    models: undefined,
  }
  useSessions.setState({ tabs: cwds.map((cwd, i) => ({ id: `t${i + 1}`, cwd }) as never), activeTabId: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(AgentLibrary)); await flush() })
  await act(async () => { container!.querySelector<HTMLElement>('[data-testid="agent-card"]')?.click(); await flush() })
  return container
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = async (b: HTMLElement) => { await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush() }) }
const goInProject = async (el: HTMLElement) => {
  const b = Array.from(el.querySelectorAll('[data-testid="agent-scope-switch"] button')).find((x) => x.textContent === 'In project') as HTMLElement
  await click(b)
}
const choose = async (el: HTMLElement, cwd: string) => {
  await act(async () => {
    const s = q(el, 'agent-project-select') as HTMLSelectElement
    s.value = cwd
    s.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
  })
}
const pickModel = async (el: HTMLElement, v: string) => {
  await act(async () => {
    const s = q(el, 'model-select') as HTMLSelectElement
    s.value = v
    s.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
  })
}

beforeEach(() => __resetModelCatalogForTests())
afterEach(() => {
  act(() => root?.unmount())
  container?.remove(); container = null; root = null
  useSessions.setState({ tabs: [], activeTabId: null })
  delete (window as unknown as { api?: unknown }).api
  vi.restoreAllMocks()
})

describe('AgentSheet In project mode', () => {
  it('Global | In project switches mode: picker lists open projects, none preselected, Save bar only in Global', async () => {
    const el = await mount([], ['/work/beta', '/work/alpha'])
    expect(q(el, 'agent-save-bar')).toBeTruthy()
    expect(q(el, 'agent-project-select')).toBeNull()
    await goInProject(el)
    const sel = q(el, 'agent-project-select') as HTMLSelectElement
    expect(Array.from(sel.options).map((o) => [o.value, o.textContent])).toEqual([['', 'In project ▾'], ['/work/alpha', 'alpha'], ['/work/beta', 'beta']])
    expect(sel.value).toBe('')
    expect(q(el, 'project-override-unselected')).toBeTruthy()
    expect(q(el, 'agent-save-bar')).toBeNull()
    await choose(el, '/work/beta')
    expect(q(el, 'agent-project-override')!.textContent).toContain('beta overlay')
    expect(q(el, 'agent-project-bar')!.textContent).toContain('/work/beta/.claude/agents/dev-lead.md')
    const global = Array.from(el.querySelectorAll('[data-testid="agent-scope-switch"] button')).find((x) => x.textContent === 'Global') as HTMLElement
    await click(global)
    expect(q(el, 'agent-save-bar')).toBeTruthy()
    expect(q(el, 'agent-project-select')).toBeNull()
  })

  it('marks overridden sections and shows the merged model', async () => {
    const el = await mount([detail('/work/alpha', ['model', 'mcpServers'], { model: 'opus', mcpServers: 'blender' })], ['/work/alpha'])
    await goInProject(el)
    await choose(el, '/work/alpha')
    expect((q(el, 'model-select') as HTMLSelectElement).value).toBe('opus')
    expect(q(el, 'agent-overridden-model')!.textContent).toContain('global: sonnet')
    expect(q(el, 'agent-overridden-mcpServers')!.textContent).toContain('+ blender')
    expect(q(el, 'agent-overridden-effort')).toBeNull()
  })

  it('writes on change to the chosen cwd (no Save), carrying existing keys and gear keys', async () => {
    const el = await mount([detail('/work/alpha', ['environment'], { environment: 'network-off' })], ['/work/alpha', '/work/beta'])
    await goInProject(el)
    await choose(el, '/work/alpha')
    await pickModel(el, 'opus')
    expect(savePersona).toHaveBeenCalledTimes(1)
    expect(savePersona.mock.calls[0][0]).toMatchObject({ name: 'dev-lead', projectCwd: '/work/alpha', model: 'opus', environment: 'network-off' })
    expect(savePersona.mock.calls[0][0]).not.toHaveProperty('effort')
  })

  it('Reset to global removes only that key; the last key removes the overlay', async () => {
    const el = await mount([detail('/work/alpha', ['model', 'packs'], { model: 'opus', packs: 'p1, p2' })], ['/work/alpha'])
    await goInProject(el)
    await choose(el, '/work/alpha')
    await click(q(el, 'agent-reset-model')!)
    expect(savePersona.mock.calls[0][0]).toMatchObject({ projectCwd: '/work/alpha', packs: ['p1', 'p2'] })
    expect(savePersona.mock.calls[0][0]).not.toHaveProperty('model')
    expect(removeOverride).not.toHaveBeenCalled()
  })

  it('removing the last key calls removeOverride, and the banner Reset drops the whole overlay', async () => {
    const el = await mount([detail('/work/alpha', ['model'], { model: 'opus' })], ['/work/alpha'])
    await goInProject(el)
    await choose(el, '/work/alpha')
    await click(q(el, 'agent-reset-model')!)
    expect(removeOverride).toHaveBeenCalledWith({ name: 'dev-lead', projectCwd: '/work/alpha' })
    expect(savePersona).not.toHaveBeenCalled()
    await click(q(el, 'agent-reset-all')!)
    expect(removeOverride).toHaveBeenLastCalledWith({ name: 'dev-lead', projectCwd: '/work/alpha' })
  })

  it('a full-body overlay is flagged and never written', async () => {
    const el = await mount([detail('/work/alpha', ['model'], { model: 'haiku' }, true)], ['/work/alpha'])
    await goInProject(el)
    await choose(el, '/work/alpha')
    expect(q(el, 'project-override-fullbody')).toBeTruthy()
    await pickModel(el, 'opus')
    expect(savePersona).not.toHaveBeenCalled()
  })

  it('no open project tabs says so; an IPC error toasts', async () => {
    const none = await mount([], [])
    await goInProject(none)
    expect(q(none, 'project-override-none')).toBeTruthy()
    act(() => root?.unmount()); none.remove()
    const error = vi.spyOn(toast, 'error')
    const el = await mount([], ['/work/alpha'])
    savePersona.mockRejectedValueOnce(new Error('project not open'))
    await goInProject(el)
    await choose(el, '/work/alpha')
    await pickModel(el, 'opus')
    expect(error).toHaveBeenCalledWith('project not open')
  })
})
