// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ConstraintsPanel } from '../ConstraintsPanel'
import { BLANK_DRAFT, type Draft } from '../AgentDetail'

const item = (id: string, badges: Array<'risky' | 'banned' | 'floor'> = []) => ({ id, label: id, badges })
const ARMORY = { builtins: [item('Task', ['banned']), item('Bash', ['risky'])], bundledSkills: [], mcpServers: [], packs: [], unpackedSkills: [], errors: [] }

let container: HTMLDivElement
let root: Root
let latest: Draft

async function mount(initial: Partial<Draft> = {}) {
  ;(window as unknown as { api: unknown }).api = {
    agents: { armory: vi.fn().mockResolvedValue(ARMORY) },
    toolRisk: { read: vi.fn().mockResolvedValue({ ok: true, path: null, exists: true, interactive: false, marks: { 'mcp__x__post': 'public', 'mcp__x__rm': 'irreversible' } }) },
    claudeConfig: { read: vi.fn().mockResolvedValue({ path: '', data: { permissions: { allow: ['a', 'b', 'c'], deny: ['d'] } } }) },
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const Host = () => {
    const [d, setD] = useState<Draft>({ ...BLANK_DRAFT, ...initial })
    latest = d
    return createElement(ConstraintsPanel, { obj: d, set: (p: Partial<Draft>) => setD((x) => ({ ...x, ...p })) })
  }
  await act(async () => { root.render(createElement(Host)); await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}
const q = (sel: string) => container.querySelector(sel) as HTMLElement
afterEach(() => { act(() => root.unmount()); container.remove() })

describe('ConstraintsPanel', () => {
  it('selecting an environment card updates the draft', async () => {
    await mount()
    expect(q('[data-environment="headless-default"]').getAttribute('aria-checked')).toBe('true')
    await act(async () => { q('[data-environment="open-web"]').click() })
    expect(latest.environment).toBe('open-web')
    expect(q('[data-environment="open-web"]').getAttribute('aria-checked')).toBe('true')
  })

  it('shows risk marks, banned chips and settings counts with no inputs', async () => {
    await mount()
    expect(q('[data-risk-mark="public"]').textContent).toContain('PUBLIC')
    expect(q('[data-risk-mark="irreversible"]').textContent).toContain('IRREVERSIBLE')
    expect(q('[data-banned="Task"]')).toBeTruthy()
    expect(q('[data-banned="Bash"]')).toBeNull()
    expect(q('[data-testid="constraints-settings-counts"]').textContent).toBe('3 allow · 1 deny')
    for (const id of ['constraints-risk-marks', 'constraints-banned', 'constraints-settings']) {
      expect(q(`[data-testid="${id}"]`).querySelectorAll('input, select, textarea').length).toBe(0)
    }
  })

  it('Open Settings navigates to the Settings tab', async () => {
    await mount()
    const seen: string[] = []
    const h = (e: Event) => seen.push((e as CustomEvent<string>).detail)
    window.addEventListener('sm:navigate', h)
    await act(async () => { q('[data-testid="constraints-open-settings"]').click() })
    window.removeEventListener('sm:navigate', h)
    expect(seen).toEqual(['settings'])
  })
})
