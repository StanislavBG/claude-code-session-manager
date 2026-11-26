// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentLibrary } from '../AgentLibrary'
import type { AgentPersona } from '../../../../preload/api'

vi.mock('../editor/DocumentEditorPane', () => ({
  DocumentEditorPane: (p: { value: string }) => createElement('div', { 'data-testid': 'document-editor-pane' }, p.value),
}))

const persona = (name: string, extra: Partial<AgentPersona> = {}): AgentPersona => ({
  name, description: `${name} does things.`, tools: ['Read', 'Bash'], model: 'opus', effort: 'high', color: 'blue',
  tags: [], projects: [], action: null, actionLabel: null, path: `/home/u/.claude/agents/${name}.md`, body: `You are ${name}.`,
  overridingProjects: [], overrideDetails: [], ...extra,
})
const PERSONAS = [persona('architect', { loadout: 'equipped' } as Partial<AgentPersona>), persona('builder')]

// The prefs file lives behind window.api.config; keep it in memory so persistence survives a remount.
let prefsFile: Record<string, unknown> = {}
let writeJson: ReturnType<typeof vi.fn>

function installApi() {
  writeJson = vi.fn(async (_p: string, data: Record<string, unknown>) => { prefsFile = data })
  ;(window as unknown as { api: unknown }).api = {
    agents: {
      listPersonas: vi.fn().mockResolvedValue(PERSONAS),
      savePersona: vi.fn().mockResolvedValue({ ok: true, path: '' }),
      deletePersona: vi.fn(), removeOverride: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    app: { homeDir: vi.fn().mockResolvedValue('/home/u') },
    config: {
      listDir: vi.fn().mockResolvedValue([]), readText: vi.fn().mockResolvedValue(''), exists: vi.fn().mockResolvedValue(false),
      readJson: vi.fn(async () => ({ exists: true, data: prefsFile })),
      writeJson,
      watch: vi.fn(), unwatch: vi.fn(), onChanged: vi.fn(() => () => {}),
    },
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }) }

async function mountSheet() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(AgentLibrary)) })
  await flush()
  await act(async () => { container!.querySelector<HTMLElement>('[data-testid="agent-card"]')?.click() })
  await flush()
  return container
}
const unmount = () => { act(() => root?.unmount()); container?.remove(); container = null; root = null }

beforeEach(() => { prefsFile = {}; installApi() })
afterEach(() => { unmount(); delete (window as unknown as { api?: unknown }).api })

const col = (el: HTMLElement) => el.querySelector('[data-testid="agent-list-column"]')!
const toggle = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-testid="agent-list-toggle"]')!

describe('AgentSheet list column', () => {
  it('is a collapsed avatar rail by default, with names on aria-label and a » toggle', async () => {
    const el = await mountSheet()
    expect(col(el).getAttribute('data-expanded')).toBe('false')
    expect(el.querySelector('[data-testid="agent-rail"]')).toBeTruthy()
    expect(el.querySelector('[data-agent-row]')).toBeNull()
    const items = el.querySelectorAll<HTMLButtonElement>('[data-agent-rail]')
    expect(items).toHaveLength(2)
    expect(items[0].tagName).toBe('BUTTON')
    expect(items[0].getAttribute('aria-label')).toContain('architect')
    expect(items[0].getAttribute('data-loadout')).toBe('equipped')
    expect(items[0].querySelector('[data-testid="agent-rail-dot"]')).toBeTruthy()
    expect(toggle(el).tagName).toBe('BUTTON')
    expect(toggle(el).textContent).toBe('»')
  })

  it('» expands to the 316 px list and « collapses it again', async () => {
    const el = await mountSheet()
    await act(async () => { toggle(el).click() })
    expect(col(el).getAttribute('data-expanded')).toBe('true')
    expect(col(el).className).toContain('w-[316px]')
    expect(toggle(el).textContent).toBe('«')
    expect(el.querySelector('[data-agent-row="builder"]')).toBeTruthy()
    await act(async () => { toggle(el).click() })
    expect(col(el).getAttribute('data-expanded')).toBe('false')
    expect(col(el).className).toContain('w-16')
  })

  it('persists the choice across a remount (restart)', async () => {
    let el = await mountSheet()
    await act(async () => { toggle(el).click() })
    await flush()
    expect(writeJson).toHaveBeenCalled()
    expect(prefsFile.agentsListExpanded).toBe(true)
    unmount()
    el = await mountSheet()
    expect(col(el).getAttribute('data-expanded')).toBe('true')
    await act(async () => { toggle(el).click() })
    await flush()
    expect(prefsFile.agentsListExpanded).toBe(false)
    unmount()
    el = await mountSheet()
    expect(col(el).getAttribute('data-expanded')).toBe('false')
  })

  it('selecting a rail item opens that agent and rings it', async () => {
    const el = await mountSheet()
    const rail = (n: string) => el.querySelector<HTMLButtonElement>(`[data-agent-rail="${n}"]`)!
    await act(async () => { rail('architect').click() })
    expect(el.querySelector('[data-testid="agent-sheet"]')!.textContent).toContain('architect')
    expect(rail('architect').getAttribute('aria-current')).toBe('true')
    expect(rail('architect').className).toContain('ring-accent')
    await act(async () => { rail('builder').click() })
    expect(rail('builder').getAttribute('aria-current')).toBe('true')
    expect(rail('architect').getAttribute('aria-current')).toBeNull()
    expect(el.querySelector('[data-testid="agent-detail-name"]')).toBeTruthy()
    expect((el.querySelector('[data-testid="agent-detail-name"]') as HTMLInputElement).value).toBe('builder')
  })
})

describe('AgentSheet save bar', () => {
  it('is quiet when clean and summarises unsaved changes, then saves through savePersona', async () => {
    const el = await mountSheet()
    const bar = () => el.querySelector('[data-testid="agent-save-summary"]')!.textContent
    const save = () => el.querySelector<HTMLButtonElement>('[data-testid="agent-save"]')!
    expect(save().disabled).toBe(true)
    const desc = el.querySelector('[data-testid="agent-detail-description"]') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { setter.call(desc, 'Changed.'); desc.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(bar()).toBe('1 unsaved change · description · applies to new sessions only')
    expect(el.querySelector('[data-testid="config-detail-pill"]')!.textContent).toBe('edited')
    await act(async () => { save().click() })
    await flush()
    expect((window as unknown as { api: { agents: { savePersona: ReturnType<typeof vi.fn> } } }).api.agents.savePersona).toHaveBeenCalledTimes(1)
  })
})
