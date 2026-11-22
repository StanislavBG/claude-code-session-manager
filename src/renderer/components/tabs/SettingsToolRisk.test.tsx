// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { SettingsToolRisk, TOOL_RISK_MARKS } from './SettingsToolRisk'
import { Settings } from './Settings'
import { useToast } from '../../state/toast'
import { useSessions, type SessionTab } from '../../state/sessions'
import { useConfig } from '../../state/config'
import { useLayout } from '../../state/layout'

const HOME = '/home/u'
const CWD = '/home/u/proj'
const SYSTEM_PATH = `${HOME}/.claude/tool-risk.json`
const PROJECT_PATH = `${CWD}/.claude/tool-risk.json`

type Marks = Record<string, string>

function installApi(opts: { marks?: Marks; interactive?: boolean; write?: (p: unknown) => unknown } = {}) {
  const read = vi.fn(async ({ scope }: { scope: string }) => ({
    ok: true,
    path: scope === 'user' ? SYSTEM_PATH : PROJECT_PATH,
    exists: true,
    marks: opts.marks ?? {},
    interactive: opts.interactive ?? false,
  }))
  const write = vi.fn(
    async (p: { scope: string }) =>
      (opts.write?.(p) as unknown) ?? { ok: true, path: p.scope === 'user' ? SYSTEM_PATH : PROJECT_PATH },
  )
  const settingsRaw = '{}\n'
  ;(window as unknown as { api: unknown }).api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    claudeConfig: { patch: vi.fn().mockResolvedValue({ ok: true, path: '', data: {} }) },
    config: {
      readJson: vi.fn().mockResolvedValue({ raw: settingsRaw, data: {}, exists: true, mtimeMs: 0, parseError: null, error: null }),
      readText: vi.fn().mockResolvedValue({ text: settingsRaw, raw: settingsRaw, exists: false, mtimeMs: 0, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      writeText: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      exists: vi.fn().mockResolvedValue(true),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    toolRisk: { read, write },
  }
  return { read, write }
}

const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  await flush()
  await flush()
  return container
}

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const qa = <T extends HTMLElement = HTMLElement>(el: HTMLElement, id: string) =>
  Array.from(el.querySelectorAll<T>(`[data-testid="${id}"]`))
const button = (el: HTMLElement, text: string) =>
  Array.from(el.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement | undefined

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
  act(() => {
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

async function save(el: HTMLElement) {
  await act(async () => {
    button(el, 'Save')!.click()
  })
  await flush()
}

const errorToasts = () => useToast.getState().toasts.filter((t) => t.kind === 'error').map((t) => t.message)

describe('SettingsToolRisk', () => {
  beforeEach(() => {
    useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  })
  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
    delete (window as unknown as { api?: unknown }).api
  })

  it('loads the scope marks via toolRisk.read and names the real file, saying Project overrides System', async () => {
    const { read } = installApi({ marks: { 'mcp__gh__create_pr': 'public', 'Bash(rm:*)': 'irreversible' } })
    const el = await mount(createElement(SettingsToolRisk, { scope: 'project', cwd: CWD }))
    expect(read).toHaveBeenCalledWith({ scope: 'project', cwd: CWD })
    const rules = qa<HTMLInputElement>(el, 'tool-risk-rule').map((i) => i.value)
    const marks = qa<HTMLSelectElement>(el, 'tool-risk-mark').map((s) => s.value)
    expect(rules).toEqual(['mcp__gh__create_pr', 'Bash(rm:*)'])
    expect(marks).toEqual(['public', 'irreversible'])
    expect(el.textContent).toContain('Project overrides System')
    expect(q(el, 'source-chip-path')?.textContent).toContain('~/proj/.claude/tool-risk.json')
    expect(el.textContent).not.toContain('unsaved')
  })

  it('offers exactly the five marks', async () => {
    installApi({ marks: { mcp__a__b: 'read' } })
    const el = await mount(createElement(SettingsToolRisk, { scope: 'user', cwd: null }))
    const options = Array.from(qa<HTMLSelectElement>(el, 'tool-risk-mark')[0].options).map((o) => o.value)
    expect(options).toEqual(['read', 'write', 'irreversible', 'money', 'public'])
    expect([...TOOL_RISK_MARKS]).toEqual(options)
  })

  it('adds a mark and saves it through toolRisk.write (System: no interactive key)', async () => {
    const { write, read } = installApi({ marks: {} })
    const el = await mount(createElement(SettingsToolRisk, { scope: 'user', cwd: null }))
    expect(read).toHaveBeenCalledWith({ scope: 'user', cwd: null })
    act(() => q(el, 'tool-risk-add')!.click())
    const [rule] = qa<HTMLInputElement>(el, 'tool-risk-rule')
    setValue(rule, 'mcp__stripe__*')
    setValue(qa<HTMLSelectElement>(el, 'tool-risk-mark')[0], 'money')
    expect(el.textContent).toContain('unsaved')
    await save(el)
    expect(write).toHaveBeenCalledWith({ scope: 'user', cwd: null, marks: { 'mcp__stripe__*': 'money' } })
    expect(el.textContent).not.toContain('unsaved')
    expect(errorToasts()).toEqual([])
  })

  it('changes a mark and removes a row', async () => {
    const { write } = installApi({ marks: { mcp__a__x: 'read', mcp__a__y: 'write' } })
    const el = await mount(createElement(SettingsToolRisk, { scope: 'project', cwd: CWD }))
    setValue(qa<HTMLSelectElement>(el, 'tool-risk-mark')[0], 'public')
    act(() => qa(el, 'tool-risk-remove')[1].click())
    expect(qa(el, 'tool-risk-row')).toHaveLength(1)
    await save(el)
    expect(write).toHaveBeenCalledWith({ scope: 'project', cwd: CWD, marks: { mcp__a__x: 'public' }, interactive: false })
  })

  it('a refused save keeps the dirty state, shows the refusal text and toasts it', async () => {
    installApi({ marks: {}, write: () => ({ ok: false, path: SYSTEM_PATH, error: 'rule "nope" is not a tool rule' }) })
    const el = await mount(createElement(SettingsToolRisk, { scope: 'user', cwd: null }))
    act(() => q(el, 'tool-risk-add')!.click())
    setValue(qa<HTMLInputElement>(el, 'tool-risk-rule')[0], 'nope')
    await save(el)
    expect(q(el, 'tool-risk-refusal')?.textContent).toBe('rule "nope" is not a tool rule')
    expect(el.textContent).toContain('unsaved')
    expect(qa<HTMLInputElement>(el, 'tool-risk-rule')[0].value).toBe('nope')
    expect(errorToasts()).toEqual(['rule "nope" is not a tool rule'])
  })

  it('a rejected write is toasted, never swallowed', async () => {
    installApi({ marks: {}, write: () => Promise.reject(new Error('ipc down')) })
    const el = await mount(createElement(SettingsToolRisk, { scope: 'user', cwd: null }))
    act(() => q(el, 'tool-risk-add')!.click())
    await save(el)
    expect(errorToasts()).toEqual(['ipc down'])
    expect(el.textContent).toContain('unsaved')
  })

  it('shows the interactive toggle only on the Project scope, and saves it', async () => {
    const { write } = installApi({ marks: {}, interactive: false })
    let el = await mount(createElement(SettingsToolRisk, { scope: 'user', cwd: null }))
    expect(q(el, 'tool-risk-interactive-toggle')).toBeNull()
    expect(el.textContent).not.toContain('Also guard interactive sessions in this project')
    act(() => root?.unmount())
    container?.remove()

    el = await mount(createElement(SettingsToolRisk, { scope: 'project', cwd: CWD }))
    expect(el.textContent).toContain('Also guard interactive sessions in this project')
    const sw = el.querySelector<HTMLButtonElement>('[data-testid="tool-risk-interactive-toggle"] [role="switch"]')!
    act(() => sw.click())
    expect(el.textContent).toContain('unsaved')
    await save(el)
    expect(write).toHaveBeenCalledWith({ scope: 'project', cwd: CWD, marks: {}, interactive: true })
  })
})

describe('Settings — Tool risk rail row', () => {
  const TAB: SessionTab = {
    id: 'tab-p',
    sessionId: 'tab-p',
    label: 'proj',
    cwd: CWD,
    pid: null,
    status: 'dormant',
    exitCode: null,
    startupCommand: null,
    presetId: null,
    generation: 0,
  }
  beforeEach(() => {
    useLayout.setState({ navFace: 'home' })
    useConfig.setState({ files: {}, watchRefs: {} })
    useSessions.setState({ tabs: [TAB], activeTabId: TAB.id })
  })
  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
    delete (window as unknown as { api?: unknown }).api
  })

  for (const scope of ['user', 'project'] as const) {
    it(`renders settings-row-tool-risk on the ${scope} scope and opens SettingsToolRisk with scope + cwd`, async () => {
      const { read } = installApi({ marks: {} })
      const el = await mount(createElement(Settings as React.ComponentType<{ scope: 'user' | 'project' }>, { scope }))
      const row = q(el, 'settings-row-tool-risk')
      expect(row).not.toBeNull()
      await act(async () => {
        row!.click()
      })
      await flush()
      expect(q(el, 'settings-tool-risk')).not.toBeNull()
      expect(read).toHaveBeenCalledWith(scope === 'user' ? { scope: 'user', cwd: null } : { scope: 'project', cwd: CWD })
      expect(q(el, 'tool-risk-interactive-toggle') !== null).toBe(scope === 'project')
    })
  }
})
