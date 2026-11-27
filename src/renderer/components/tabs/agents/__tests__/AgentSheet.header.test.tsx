// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentLibrary } from '../../AgentLibrary'
import { useSessions } from '../../../../state/sessions'
import { __resetModelCatalogForTests } from '../../../../lib/useModelCatalog'
import type { AgentPersona } from '../../../../../preload/api'

vi.mock('../../../../lib/uiSettingsPrefs', () => ({
  readUiSettingsPrefs: async () => ({ agentsListExpanded: true }),
  writeUiSettingsPrefs: async () => {},
}))
vi.mock('../../editor/DocumentEditorPane', () => ({
  DocumentEditorPane: () => createElement('div', { 'data-testid': 'document-editor-pane' }),
}))

const persona = (loadout: string, tools: string[], extra: object = {}): AgentPersona => ({
  name: 'dev-lead', description: 'd', tools, model: 'sonnet', effort: null, color: null,
  tags: [], projects: [], action: null, actionLabel: null, path: '/x/dev-lead.md', body: 'b',
  overridingProjects: [], overrideDetails: [], loadout, ...extra,
}) as unknown as AgentPersona

let container: HTMLDivElement | null = null
let root: Root | null = null
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

async function mount(p: AgentPersona) {
  ;(window as unknown as { api: unknown }).api = {
    agents: {
      listPersonas: vi.fn().mockResolvedValue([p]),
      armory: vi.fn().mockResolvedValue({ builtins: ['Read', 'Grep', 'Edit'].map((id) => ({ id, label: id, badges: [] })), bundledSkills: [], mcpServers: [], packs: [], unpackedSkills: [], errors: [] }),
      savePersona: vi.fn(), deletePersona: vi.fn(), removeOverride: vi.fn(), onChanged: vi.fn(() => () => {}),
    },
    app: { homeDir: vi.fn().mockResolvedValue('/home/bilko') },
    config: {
      listDir: vi.fn().mockResolvedValue([]), readText: vi.fn().mockResolvedValue(''), exists: vi.fn().mockResolvedValue(false),
      watch: vi.fn(), unwatch: vi.fn(), onChanged: vi.fn(() => () => {}),
    },
    models: undefined,
  }
  useSessions.setState({ tabs: [], activeTabId: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(AgentLibrary)); await flush() })
  await act(async () => { container!.querySelector<HTMLElement>('[data-testid="agent-card"]')?.click(); await flush() })
  return container
}
const badge = (el: HTMLElement) => el.querySelector('[data-testid="agent-loadout-badge"]')!.textContent

beforeEach(() => __resetModelCatalogForTests())
afterEach(() => {
  act(() => root?.unmount())
  container?.remove(); container = null; root = null
  delete (window as unknown as { api?: unknown }).api
  vi.restoreAllMocks()
})

describe('AgentSheet header summary', () => {
  it('saved Bare reads floor only', async () => {
    expect(badge(await mount(persona('bare', [])))).toBe('Bare · floor only')
  })
  it('Unbound (tools *) reads every tool, and Grant all switches a Bare draft to it', async () => {
    expect(badge(await mount(persona('unbound', ['*'])))).toBe('Unbound · every tool')
  })
  it('Grant all on a Bare agent reads every tool, not 0 tools', async () => {
    const el = await mount(persona('bare', []))
    await act(async () => { el.querySelector<HTMLElement>('[data-testid="agent-tools-all"]')?.click(); await flush() })
    expect(badge(el)).toBe('Unbound · every tool')
  })
  it('Undecided reads no decision', async () => {
    expect(badge(await mount(persona('undecided', [])))).toBe('Undecided · no decision — every tool')
  })
  it('Equipped counts tools, servers and packs', async () => {
    const el = await mount(persona('equipped', ['Read', 'Grep', 'mcp__blender__a', 'mcp__blender__b'], { packs: ['p1'] }))
    expect(badge(el)).toBe('Equipped · 2 tools · 1 server · 1 pack')
  })
})
