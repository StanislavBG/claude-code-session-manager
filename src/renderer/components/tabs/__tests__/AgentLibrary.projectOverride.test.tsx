// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentLibrary } from '../AgentLibrary'
import { useSessions } from '../../../state/sessions'
import { toast } from '../../../state/toast'
import { __resetModelCatalogForTests } from '../../../lib/useModelCatalog'
import type { AgentPersona } from '../../../../preload/api'

/**
 * The PROJECT OVERRIDE block picks its project from an explicit dropdown of every open project
 * (one option per unique tab cwd, nothing preselected) — never from the active tab. Every mount
 * below sets an active tab on purpose, so a regression back to "the last focused tab" fails here.
 */

type Detail = NonNullable<AgentPersona['overrideDetails']>[number]

function persona(details: Detail[] = [], name = 'dev-lead'): AgentPersona {
  return {
    name, description: 'd', tools: [], model: 'sonnet', effort: null, color: null,
    tags: [], projects: [], action: null, actionLabel: null, path: `/x/${name}.md`, body: 'b',
    overridingProjects: details.map((d) => d.project), overrideDetails: details,
  }
}

const detail = (cwd: string, fields: string[], values: Record<string, string>, bodyOverridden = false): Detail => ({
  project: cwd.split('/').filter(Boolean).pop()!, cwd, fields, values, bodyOverridden, issue: null,
})

let container: HTMLDivElement | null = null
let root: Root | null = null
let savePersona: ReturnType<typeof vi.fn>
let removeOverride: ReturnType<typeof vi.fn>

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

/** One tab per cwd; the ACTIVE tab is the last one unless `activeIdx` says otherwise — the page must ignore it. */
async function mount(details: Detail[], cwds: string[], opts: { activeIdx?: number; personas?: AgentPersona[] } = {}) {
  savePersona = vi.fn().mockResolvedValue({ ok: true, path: '' })
  removeOverride = vi.fn().mockResolvedValue({ ok: true })
  ;(window as unknown as { api: unknown }).api = {
    agents: {
      listPersonas: vi.fn().mockResolvedValue(opts.personas ?? [persona(details)]),
      savePersona, deletePersona: vi.fn(), removeOverride,
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
    models: undefined, // catalog === null → static option lists
  }
  useSessions.setState({
    tabs: cwds.map((cwd, i) => ({ id: `t${i + 1}`, cwd }) as never),
    activeTabId: cwds.length ? `t${(opts.activeIdx ?? cwds.length - 1) + 1}` : null,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(AgentLibrary))
    await flush()
  })
  return container
}

const q = (el: HTMLElement, testid: string) => el.querySelector(`[data-testid="${testid}"]`)
const select = (el: HTMLElement) => q(el, 'override-project-select') as HTMLSelectElement
const options = (el: HTMLElement) => Array.from(select(el).options).map((o) => [o.value, o.textContent])
const choose = async (el: HTMLElement, cwd: string) => {
  await act(async () => {
    const s = select(el)
    s.value = cwd
    s.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
  })
}
const within = (el: HTMLElement, testid: string, text: string) =>
  Array.from(q(el, testid)!.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement
const click = async (b: HTMLElement) => {
  await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush() })
}

beforeEach(() => __resetModelCatalogForTests())
afterEach(() => {
  act(() => root?.unmount())
  container?.remove(); container = null; root = null
  useSessions.setState({ tabs: [], activeTabId: null })
  delete (window as unknown as { api?: unknown }).api
  vi.restoreAllMocks()
})

describe('AgentLibrary project override', () => {
  it('lists every open project sorted by name, selects none whatever the active tab is, and shows no pickers', async () => {
    const el = await mount([], ['/work/beta', '/work/alpha'], { activeIdx: 1 })
    expect(options(el)).toEqual([['', 'Choose a project…'], ['/work/alpha', 'alpha'], ['/work/beta', 'beta']])
    expect(select(el).value).toBe('')
    expect(select(el).disabled).toBe(false)
    expect(q(el, 'project-override-unselected')).toBeTruthy()
    expect(q(el, 'project-override')).toBeNull()
    expect(q(el, 'override-model-row')).toBeNull()
    expect(q(el, 'override-effort-row')).toBeNull()
  })

  it('selecting the first tab\'s project shows its overlay and writes ITS cwd, not the active tab\'s', async () => {
    const el = await mount([], ['/work/beta', '/work/alpha'], { activeIdx: 1 })
    await choose(el, '/work/beta')
    expect(select(el).value).toBe('/work/beta')
    expect(q(el, 'project-override-unselected')).toBeNull()
    expect(q(el, 'project-override')!.textContent).toContain('beta only')
    expect(q(el, 'project-override')!.textContent).toContain('/work/beta/.claude/agents/dev-lead.md')
    await click(within(el, 'override-model-row', 'opus'))
    expect(savePersona).toHaveBeenCalledTimes(1)
    expect(savePersona.mock.calls[0][0]).toMatchObject({ name: 'dev-lead', projectCwd: '/work/beta', model: 'opus', effort: 'inherit' })
    expect(savePersona.mock.calls[0][0]).not.toHaveProperty('projectName')
  })

  it('no open project tabs: the select is disabled and says to open one', async () => {
    const el = await mount([], [])
    expect(select(el).disabled).toBe(true)
    expect(options(el)).toEqual([['', 'Choose a project…']])
    expect(q(el, 'project-override-none')!.textContent).toContain('open a project tab to override this persona')
    expect(q(el, 'project-override')).toBeNull()
    expect(q(el, 'override-model-row')).toBeNull()
  })

  it('a cwd open with and without a trailing slash is one option, sent normalized', async () => {
    const el = await mount([], ['/work/alpha/', '/work/alpha'])
    expect(options(el)).toEqual([['', 'Choose a project…'], ['/work/alpha', 'alpha']])
    await choose(el, '/work/alpha')
    await click(within(el, 'override-model-row', 'opus'))
    expect(savePersona.mock.calls[0][0]).toMatchObject({ projectCwd: '/work/alpha' })
  })

  it('an option names what that project already overrides, or "full body"', async () => {
    const el = await mount([
      detail('/work/alpha', ['name', 'model', 'effort'], { model: 'opus', effort: 'high' }),
      detail('/work/gamma', [], {}, true),
    ], ['/work/alpha', '/work/beta', '/work/gamma'])
    expect(options(el).map(([, label]) => label)).toEqual([
      'Choose a project…', 'alpha — overrides model, effort', 'beta', 'gamma — overrides full body',
    ])
  })

  it('two open projects sharing a folder name get distinct labels; the block reads and writes the chosen cwd', async () => {
    const el = await mount([
      detail('/a/proj', ['model'], { model: 'haiku' }),
      detail('/b/proj', ['model', 'effort'], { model: 'claude-opus-4-6', effort: 'high' }),
    ], ['/a/proj', '/b/proj'], { activeIdx: 0 })
    expect(options(el).slice(1)).toEqual([
      ['/a/proj', '/a/proj — overrides model'],
      ['/b/proj', '/b/proj — overrides model, effort'],
    ])
    await choose(el, '/b/proj')
    expect(q(el, 'override-provenance-model')!.textContent).toContain('claude-opus-4-6')
    await click(within(el, 'override-model-row', 'opus'))
    expect(savePersona.mock.calls[0][0]).toMatchObject({ name: 'dev-lead', projectCwd: '/b/proj', model: 'opus', effort: 'high' })
  })

  it('two projects sharing a folder name: the badge tooltip lists both and each chip × drops its own cwd', async () => {
    const el = await mount([
      detail('/a/proj', ['model'], { model: 'haiku' }),
      detail('/b/proj', ['model', 'effort'], { model: 'claude-opus-4-6', effort: 'high' }),
    ], ['/a/proj', '/b/proj'])
    const badge = Array.from(el.querySelectorAll('span[title]')).find((s) => /2 overrides/.test(s.textContent ?? ''))!
    expect(badge.getAttribute('title')).toBe('proj: model\nproj: model, effort')
    const drops = () => Array.from(el.querySelectorAll('button')).filter((b) => b.title === 'Drop the local copy')
    expect(drops()).toHaveLength(2)
    await click(drops()[1])
    expect(removeOverride).toHaveBeenLastCalledWith({ name: 'dev-lead', projectCwd: '/b/proj' })
    await click(drops()[0])
    expect(removeOverride).toHaveBeenLastCalledWith({ name: 'dev-lead', projectCwd: '/a/proj' })
  })

  it('adding effort keeps the existing model and sends the effort', async () => {
    const el = await mount([detail('/work/alpha', ['model'], { model: 'opus' })], ['/work/alpha'])
    await choose(el, '/work/alpha')
    await click(within(el, 'override-effort-row', 'high'))
    expect(savePersona.mock.calls[0][0]).toMatchObject({ projectCwd: '/work/alpha', model: 'opus', effort: 'high' })
  })

  it('clearing both goes through removeOverride for the chosen cwd, not savePersona', async () => {
    const el = await mount([detail('/work/alpha', ['model'], { model: 'opus' })], ['/work/alpha', '/work/beta'])
    await choose(el, '/work/alpha')
    await click(within(el, 'override-model-row', 'use global'))
    expect(removeOverride).toHaveBeenCalledWith({ name: 'dev-lead', projectCwd: '/work/alpha' })
    expect(savePersona).not.toHaveBeenCalled()
  })

  it('a full-body overlay is flagged and its pickers are disabled (never converted)', async () => {
    const el = await mount([detail('/work/alpha', ['model'], { model: 'haiku' }, true)], ['/work/alpha'])
    await choose(el, '/work/alpha')
    expect(q(el, 'project-override-fullbody')).toBeTruthy()
    const b = within(el, 'override-model-row', 'opus')
    expect(b.matches(':disabled')).toBe(true)
    await click(b)
    expect(savePersona).not.toHaveBeenCalled()
  })

  it('renders provenance as global → project', async () => {
    const el = await mount([detail('/work/alpha', ['model'], { model: 'claude-opus-4-6' })], ['/work/alpha'])
    await choose(el, '/work/alpha')
    const t = q(el, 'override-provenance-model')!.textContent!
    expect(t).toContain('sonnet')
    expect(t).toContain('claude-opus-4-6')
    expect(t.indexOf('sonnet')).toBeLessThan(t.indexOf('claude-opus-4-6'))
    expect(q(el, 'override-provenance-effort')!.textContent).toContain('not overridden')
  })

  it('the global model row keeps writing the global persona (no projectCwd) while a project is chosen', async () => {
    const el = await mount([], ['/work/alpha'])
    await choose(el, '/work/alpha')
    await click(within(el, 'model-row', 'opus'))
    const save = Array.from(el.querySelectorAll('button')).find((b) => /^save$/i.test(b.textContent ?? ''))!
    await click(save)
    expect(savePersona.mock.calls[0][0].projectCwd).toBeUndefined()
    expect(savePersona.mock.calls[0][0]).not.toHaveProperty('projectName')
  })

  it('the chosen project survives switching personas and falls back to "Choose a project…" when its tab closes', async () => {
    const el = await mount([], ['/work/alpha', '/work/beta'], { personas: [persona([]), persona([], 'architect')] })
    await choose(el, '/work/beta')
    await click(el.querySelector('[data-agent-row="architect"]') as HTMLElement)
    expect(select(el).value).toBe('/work/beta')
    expect(q(el, 'project-override')!.textContent).toContain('/work/beta/.claude/agents/architect.md')
    await act(async () => {
      useSessions.setState({ tabs: [{ id: 't1', cwd: '/work/alpha' } as never] })
      await flush()
    })
    expect(select(el).value).toBe('')
    expect(options(el)).toEqual([['', 'Choose a project…'], ['/work/alpha', 'alpha']])
    expect(q(el, 'project-override-unselected')).toBeTruthy()
    expect(q(el, 'override-model-row')).toBeNull()
  })

  it('an IPC error (e.g. the project closed meanwhile) surfaces as an error toast', async () => {
    const error = vi.spyOn(toast, 'error')
    const el = await mount([], ['/work/alpha'])
    savePersona.mockRejectedValueOnce(new Error('project not open'))
    await choose(el, '/work/alpha')
    await click(within(el, 'override-model-row', 'opus'))
    expect(error).toHaveBeenCalledWith('project not open')
  })
})
