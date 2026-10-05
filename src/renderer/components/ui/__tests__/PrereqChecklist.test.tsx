// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { PrereqChecklist } from '../PrereqChecklist'
import { useToast } from '../../../state/toast'
import { flushAsync } from '../../../testUtils/domFlush'
import type { PrereqItem } from '../../../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null

const okItem: PrereqItem = { id: 'git', label: 'Git', ok: true, version: '2.4', detail: null, fix: null }
const missing: PrereqItem = {
  id: 'claude-cli',
  label: 'Claude CLI',
  ok: false,
  version: null,
  detail: 'claude not found on PATH',
  fix: { command: 'npm i -g @anthropic-ai/claude-code', shell: 'sh', url: 'https://example.com/howto' },
}

const prereqs = vi.fn()
const prereqsRunFix = vi.fn()

beforeEach(() => {
  prereqs.mockReset()
  prereqsRunFix.mockReset()
  ;(window as unknown as { api: unknown }).api = { app: { prereqs, prereqsRunFix } }
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<PrereqChecklist />))
  await flushAsync()
  return container
}

function button(c: HTMLElement, text: string) {
  return Array.from(c.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement
}

describe('PrereqChecklist', () => {
  it('renders nothing when every item is ok', async () => {
    prereqs.mockResolvedValue([okItem])
    const c = await mount()
    expect(c.innerHTML).toBe('')
  })

  it('shows the command for a missing claude-cli and runs the fix on Install', async () => {
    prereqs.mockResolvedValue([okItem, missing])
    prereqsRunFix.mockResolvedValue({ ok: true, opener: 'x-terminal-emulator' })
    const c = await mount()
    expect(c.textContent).toContain('npm i -g @anthropic-ai/claude-code')
    expect(c.textContent).toContain('claude not found on PATH')
    act(() => button(c, 'Install').click())
    await flushAsync()
    expect(prereqsRunFix).toHaveBeenCalledWith('claude-cli')
  })

  it('Re-check refetches', async () => {
    prereqs.mockResolvedValue([missing])
    const c = await mount()
    expect(prereqs).toHaveBeenCalledTimes(1)
    act(() => button(c, 'Re-check').click())
    await flushAsync()
    expect(prereqs).toHaveBeenCalledTimes(2)
  })

  it('shows an error toast when Install rejects', async () => {
    prereqs.mockResolvedValue([missing])
    prereqsRunFix.mockRejectedValue(new Error('boom'))
    const c = await mount()
    act(() => button(c, 'Install').click())
    await flushAsync()
    const toasts = useToast.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].kind).toBe('error')
    expect(toasts[0].message).toContain('boom')
  })
})
