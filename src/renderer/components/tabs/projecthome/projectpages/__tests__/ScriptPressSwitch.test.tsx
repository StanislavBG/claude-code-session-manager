// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ScriptPressSwitch } from '../ScriptPressSwitch'
import { useToast } from '../../../../../state/toast'
import type { VideoScriptSwitchState } from '../../../../../../preload/api'

const scriptSwitchGet = vi.fn()
const scriptSwitchSet = vi.fn()

const OFF: VideoScriptSwitchState = { enabled: false, changedAt: null, by: null }

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  scriptSwitchGet.mockReset().mockResolvedValue(OFF)
  scriptSwitchSet
    .mockReset()
    .mockImplementation(async ({ enabled }: { enabled: boolean }) => ({
      enabled,
      changedAt: '2026-11-24T10:00:00.000Z',
      by: { via: 'ui' },
    }))
  ;(window as unknown as { api: unknown }).api = { projectPages: { scriptSwitchGet, scriptSwitchSet } }
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })

async function mount(cwd = '/proj') {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<ScriptPressSwitch cwd={cwd} />))
  await flush()
  return container
}

const tid = (id: string) => container!.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const click = async (el: HTMLElement | null) => {
  act(() => el!.click())
  await flush()
}
const toasts = () => (useToast.getState() as unknown as { toasts: { kind: string; message: string }[] }).toasts

describe('ScriptPressSwitch', () => {
  it('is collapsed by default and reads nothing until opened', async () => {
    await mount()
    const toggle = tid('script-press-switch-toggle')!
    expect(toggle.textContent).toContain('Scripts')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(tid('script-press-switch-body')).toBeNull()
    expect(tid('script-press-switch-checkbox')).toBeNull()
    expect(scriptSwitchGet).not.toHaveBeenCalled()
  })

  it('opened, shows the checkbox bound to the cwd, the route hint and who changed it', async () => {
    scriptSwitchGet.mockResolvedValue({
      enabled: true,
      changedAt: '2026-11-24T09:00:00.000Z',
      by: { via: 'agent', claudeSessionId: 's1', quote: 'let scripts run it', promptAt: '2026-11-24T08:59:00.000Z' },
    })
    await mount()
    await click(tid('script-press-switch-toggle'))
    expect(scriptSwitchGet).toHaveBeenCalledWith({ cwd: '/proj' })
    const box = tid('script-press-switch-checkbox') as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(tid('script-press-switch-body')!.textContent).toContain('Scripts may run Demo Video')
    expect(tid('script-press-switch-hint')!.textContent).toContain('POST /admin/project-home/videos/run')
    expect(tid('script-press-switch-by')!.textContent).toBe('changed by an agent quoting you')
  })

  it('toggling calls scriptSwitchSet with the cwd and shows changed by you', async () => {
    await mount('/my/project')
    await click(tid('script-press-switch-toggle'))
    expect(tid('script-press-switch-by')).toBeNull()
    await click(tid('script-press-switch-checkbox'))
    expect(scriptSwitchSet).toHaveBeenCalledWith({ cwd: '/my/project', enabled: true })
    expect((tid('script-press-switch-checkbox') as HTMLInputElement).checked).toBe(true)
    expect(tid('script-press-switch-by')!.textContent).toBe('changed by you')
  })

  it('an IPC error shows an error toast', async () => {
    scriptSwitchSet.mockRejectedValue(new Error('bad payload'))
    await mount()
    await click(tid('script-press-switch-toggle'))
    await click(tid('script-press-switch-checkbox'))
    const errs = toasts().filter((t) => t.kind === 'error')
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toContain('bad payload')
    expect((tid('script-press-switch-checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('a failed read shows an error toast', async () => {
    scriptSwitchGet.mockRejectedValue(new Error('invalid cwd'))
    await mount()
    await click(tid('script-press-switch-toggle'))
    expect(toasts().some((t) => t.kind === 'error' && t.message.includes('invalid cwd'))).toBe(true)
  })
})
