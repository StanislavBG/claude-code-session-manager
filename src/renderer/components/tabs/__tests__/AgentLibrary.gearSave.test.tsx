// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentLibrary } from '../AgentLibrary'
import { useSessions } from '../../../state/sessions'
import { overlayEdit, overlayOf } from '../agents/AgentDetail'
import type { AgentPersona } from '../../../../preload/api'

// Stub the sheet: it exposes the draft setter + Save/Revert/override so the test drives AgentLibrary's save payload.
vi.mock('../agents/AgentSheet', () => ({
  useAgentsListExpanded: () => [true, () => {}],
  AgentWorkbench: (p: { list: unknown; detail: unknown }) => createElement('div', null, p.list as never, p.detail as never),
  AgentSheet: (p: {
    obj: { packs?: string[]; environment?: string; loadout?: string; mcpServers?: string[] }
    set: (v: Record<string, unknown>) => void
    onSave: () => void
    onRevert: () => void
    onSaveOverride: (o: Record<string, unknown>) => void
    onSelect: (cwd: string | null) => void
  }) =>
    createElement('div', null, [
      createElement('button', { key: 'p', 'data-testid': 'g-pack', onClick: () => p.set({ packs: ['pk'], mcpServers: ['m1'] }) }),
      createElement('button', { key: 'e', 'data-testid': 'g-env', onClick: () => p.set({ environment: 'sandbox' }) }),
      createElement('button', { key: 'b', 'data-testid': 'g-bare', onClick: () => p.set({ tools: [], loadout: 'bare' }) }),
      createElement('button', { key: 's', 'data-testid': 'g-save', onClick: () => p.onSave() }),
      createElement('button', { key: 'r', 'data-testid': 'g-revert', onClick: () => p.onRevert() }),
      createElement('span', { key: 'o', 'data-testid': 'g-packs' }, JSON.stringify(p.obj.packs ?? null)),
      createElement('button', { key: 'sel', 'data-testid': 'g-select', onClick: () => p.onSelect('/work/proj') }),
      createElement('button', { key: 'ov', 'data-testid': 'g-overlay', onClick: () => p.onSaveOverride({ tools: [] }) }),
      createElement('button', { key: 'ovs', 'data-testid': 'g-overlay-servers', onClick: () => p.onSaveOverride({ mcpServers: [] }) }),
      createElement('button', { key: 'ovp', 'data-testid': 'g-overlay-packs', onClick: () => p.onSaveOverride({ packs: [] }) }),
      createElement('button', { key: 'd', 'data-testid': 'g-desc', onClick: () => p.set({ description: 'edited' }) }),
      createElement('button', { key: 'm', 'data-testid': 'g-model', onClick: () => p.set({ model: 'opus' }) }),
      createElement('button', { key: 'gn', 'data-testid': 'g-none', onClick: () => p.set({ tools: [] }) }),
    ]),
}))

const PERSONA: AgentPersona = {
  name: 'builder', description: 'd', tools: ['Read'], model: null, effort: null, color: null,
  tags: [], projects: [], action: null, actionLabel: null, path: '/h/.claude/agents/builder.md', body: 'b',
  overridingProjects: [], overrideDetails: [],
}

const withPersona = async (extra: Record<string, unknown>) => {
  api.agents.listPersonas.mockResolvedValue([{ ...PERSONA, ...extra }])
  act(() => root?.unmount()); container?.remove()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => { root!.render(createElement(AgentLibrary)); await Promise.resolve(); await Promise.resolve() })
  await act(async () => { container!.querySelector<HTMLElement>('[data-testid="agent-card"]')?.click(); await Promise.resolve() })
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let api: { agents: { savePersona: ReturnType<typeof vi.fn>; listPersonas: ReturnType<typeof vi.fn> } }

const click = async (id: string) => {
  await act(async () => { container!.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.click(); await Promise.resolve() })
}

beforeEach(async () => {
  api = {
    agents: {
      listPersonas: vi.fn().mockResolvedValue([PERSONA]),
      savePersona: vi.fn().mockResolvedValue({ ok: true, path: '' }),
      deletePersona: vi.fn(), removeOverride: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    app: { homeDir: vi.fn().mockResolvedValue('/h') },
    config: { listDir: vi.fn().mockResolvedValue([]), readText: vi.fn().mockResolvedValue(''), exists: vi.fn().mockResolvedValue(false), watch: vi.fn(), unwatch: vi.fn(), onChanged: vi.fn(() => () => {}) },
  } as never
  ;(window as unknown as { api: unknown }).api = api
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(AgentLibrary)); await Promise.resolve(); await Promise.resolve() })
  await act(async () => { container!.querySelector<HTMLElement>('[data-testid="agent-card"]')?.click(); await Promise.resolve() })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('AgentLibrary global save sends gear', () => {
  it('equip a pack -> Save sends packs and mcpServers', async () => {
    await click('g-pack'); await click('g-save')
    expect(api.agents.savePersona).toHaveBeenCalledWith(expect.objectContaining({ packs: ['pk'], mcpServers: ['m1'] }))
  })
  it('choose a sandbox -> Save sends environment', async () => {
    await click('g-env'); await click('g-save')
    expect(api.agents.savePersona).toHaveBeenCalledWith(expect.objectContaining({ environment: 'sandbox' }))
  })
  it('Go bare -> Save sends loadout bare', async () => {
    await click('g-bare'); await click('g-save')
    expect(api.agents.savePersona).toHaveBeenCalledWith(expect.objectContaining({ loadout: 'bare', tools: [] }))
  })
  it('saved Bare + description edit -> Save sends loadout bare, tools []', async () => {
    await withPersona({ tools: [], loadout: 'bare' })
    await click('g-desc'); await click('g-save')
    const sent = api.agents.savePersona.mock.calls[0][0]
    expect(sent.loadout).toBe('bare'); expect(sent.tools).toEqual([]); expect(sent.description).toBe('edited')
  })
  it('saved Undecided + model edit -> Save sends no loadout and no tools', async () => {
    await withPersona({ tools: [] })
    await click('g-model'); await click('g-save')
    const sent = api.agents.savePersona.mock.calls[0][0]
    expect(sent.model).toBe('opus'); expect('loadout' in sent).toBe(false); expect(sent.tools == null || sent.tools.length === 0).toBe(true)
  })
  it('Revert restores the gear fields', async () => {
    await click('g-pack')
    expect(container!.querySelector('[data-testid="g-packs"]')!.textContent).toBe('["pk"]')
    await click('g-revert')
    expect(container!.querySelector('[data-testid="g-packs"]')!.textContent).toBe('null')
  })
  it('a failed save keeps the draft dirty', async () => {
    api.agents.savePersona.mockRejectedValueOnce(new Error('nope'))
    await click('g-pack'); await click('g-save')
    expect(container!.querySelector('[data-testid="g-packs"]')!.textContent).toBe('["pk"]')
  })
  it('clearing every tool globally (no explicit choice) saves loadout bare, never unbound', async () => {
    await click('g-none'); await click('g-save')
    const sent = api.agents.savePersona.mock.calls[0][0]
    expect(sent.tools).toEqual([]); expect(sent.loadout).toBe('bare')
  })
  describe('project overlay write path', () => {
    beforeEach(async () => {
      useSessions.setState({ tabs: [{ id: 't1', cwd: '/work/proj' }] as never, activeTabId: 't1' })
      await click('g-select')
    })
    afterEach(() => { useSessions.setState({ tabs: [], activeTabId: null }) })
    it('servers cleared -> mcpServers: []', async () => {
      await click('g-overlay-servers')
      expect(api.agents.savePersona).toHaveBeenCalledWith(expect.objectContaining({ projectCwd: '/work/proj', mcpServers: [] }))
    })
    it('packs cleared -> packs: []', async () => {
      await click('g-overlay-packs')
      expect(api.agents.savePersona).toHaveBeenCalledWith(expect.objectContaining({ projectCwd: '/work/proj', packs: [] }))
    })
    it('all tools cleared -> tools: [] + loadout bare', async () => {
      await click('g-overlay')
      const sent = api.agents.savePersona.mock.calls[0][0]
      expect(sent.tools).toEqual([]); expect(sent.loadout).toBe('bare')
    })
  })
  it('overlayEdit keeps emptied mcpServers/packs as []; overlayOf round-trips them', () => {
    expect(overlayEdit({}, { mcpServers: [], packs: [] })).toEqual({ mcpServers: [], packs: [] })
    expect(overlayEdit({ packs: ['a'] }, { packs: undefined })).toEqual({})
    const d = { fields: ['mcpServers', 'packs', 'tools'], values: { mcpServers: '[]', packs: '[]', tools: '[]' } } as never
    expect(overlayOf(d)).toEqual({ mcpServers: [], packs: [], tools: [] })
  })
})
