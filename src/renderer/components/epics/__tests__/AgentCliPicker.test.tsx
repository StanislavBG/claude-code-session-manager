// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentCliPicker, type AgentCliChoice } from '../AgentCliPicker'
import { useToast } from '../../../state/toast'
import type { AgentCliDetectRow } from '../../../../preload/api'

const row = (id: AgentCliDetectRow['id'], label: string, installed: boolean): AgentCliDetectRow => ({
  id,
  label,
  installed,
  path: installed ? `/usr/bin/${id}` : null,
  version: installed ? '1.0.0' : null,
  install: installed ? null : `npm i -g ${id}-cli`,
  docs: `https://example.com/${id}`,
  login: null,
})
const ROWS: AgentCliDetectRow[] = [
  row('codex', 'Codex', true),
  row('gemini', 'Gemini CLI', false),
  row('antigravity', 'Antigravity CLI', false),
  row('cursor', 'Cursor Agent', false),
  row('opencode', 'OpenCode', true),
]

const detectSpy = vi.fn(async (_p?: { refresh?: boolean }): Promise<AgentCliDetectRow[]> => ROWS)
const writeTextSpy = vi.fn(async (_t: string) => ({ ok: true }))
const shellOpenSpy = vi.fn(async (_o: unknown) => ({ ok: true }))

let container: HTMLDivElement | null = null
let root: Root | null = null
const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = (n: Element) => act(() => { n.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

async function mount(value: AgentCliChoice = 'claude', onChange = vi.fn()) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<AgentCliPicker value={value} onChange={onChange} />))
  await act(async () => {})
  return onChange
}

beforeEach(() => {
  useToast.setState({ toasts: [], history: [] } as never)
  detectSpy.mockReset()
  detectSpy.mockResolvedValue(ROWS)
  writeTextSpy.mockClear()
  shellOpenSpy.mockClear()
  ;(window as unknown as { api: unknown }).api = {
    agentCli: { detect: detectSpy },
    clipboard: { writeText: writeTextSpy },
    shell: { open: shellOpenSpy },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('AgentCliPicker', () => {
  it('lists Claude Code first and selected, then one option per detected CLI', async () => {
    await mount()
    expect(detectSpy).toHaveBeenCalledWith({})
    const options = Array.from(q('new-epic-agent-cli')!.querySelectorAll('[data-testid^="new-epic-agent-cli-option-"]'))
    expect(options.map((o) => o.getAttribute('data-testid'))).toEqual([
      'new-epic-agent-cli-option-claude',
      'new-epic-agent-cli-option-codex',
      'new-epic-agent-cli-option-gemini',
      'new-epic-agent-cli-option-antigravity',
      'new-epic-agent-cli-option-cursor',
      'new-epic-agent-cli-option-opencode',
    ])
    expect(q('new-epic-agent-cli-option-claude')!.getAttribute('aria-checked')).toBe('true')
    expect(q('new-epic-agent-cli-option-codex')!.textContent).toBe('Codex')
    expect((q('new-epic-agent-cli-option-codex') as HTMLButtonElement).disabled).toBe(false)
  })

  it('disables a not-installed CLI and shows its copyable install command and docs link', async () => {
    const onChange = await mount()
    const gemini = q('new-epic-agent-cli-option-gemini') as HTMLButtonElement
    expect(gemini.disabled).toBe(true)
    click(gemini)
    expect(onChange).not.toHaveBeenCalled()
    expect(q('new-epic-agent-cli-install-gemini')!.textContent).toContain('npm i -g gemini-cli')
    expect(q('new-epic-agent-cli-install-codex')).toBeNull()
    click(q('new-epic-agent-cli-copy-gemini')!)
    await act(async () => {})
    expect(writeTextSpy).toHaveBeenCalledWith('npm i -g gemini-cli')
    const docs = q('new-epic-agent-cli-docs-gemini') as HTMLAnchorElement
    expect(docs.getAttribute('href')).toBe('https://example.com/gemini')
    click(docs)
    await act(async () => {})
    expect(shellOpenSpy).toHaveBeenCalledWith({ as: 'external', url: 'https://example.com/gemini' })

    click(q('new-epic-agent-cli-option-codex')!)
    expect(onChange).toHaveBeenCalledWith('codex')
  })

  it('Re-check calls detect with refresh:true and re-renders the new rows', async () => {
    await mount()
    detectSpy.mockResolvedValue(ROWS.map((r) => (r.id === 'gemini' ? { ...r, installed: true, install: null } : r)))
    click(q('new-epic-agent-cli-recheck')!)
    await act(async () => {})
    expect(detectSpy).toHaveBeenLastCalledWith({ refresh: true })
    expect((q('new-epic-agent-cli-option-gemini') as HTMLButtonElement).disabled).toBe(false)
    expect(q('new-epic-agent-cli-install-gemini')).toBeNull()
  })

  it('a detect failure toasts an error and leaves only Claude Code enabled', async () => {
    detectSpy.mockRejectedValue(new Error('boom'))
    await mount()
    const toasts = useToast.getState().toasts
    expect(toasts.some((t) => t.kind === 'error' && t.message.includes('boom'))).toBe(true)
    expect((q('new-epic-agent-cli-option-claude') as HTMLButtonElement).disabled).toBe(false)
    for (const id of ['codex', 'gemini', 'antigravity', 'cursor', 'opencode']) {
      expect((q(`new-epic-agent-cli-option-${id}`) as HTMLButtonElement).disabled).toBe(true)
    }
  })
})
