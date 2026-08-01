// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { SessionManagerConfig } from '../SessionManagerConfig'
import { flushAsync } from '../../../testUtils/domFlush'

// GlobalControlsSection pulls in a much larger IPC surface (config, homeDir,
// skills) unrelated to the toggle under test here — stub it to keep this
// suite scoped to the Behavior section.
vi.mock('../GlobalControlsSection', () => ({
  GlobalControlsSection: () => createElement('div', { 'data-testid': 'global-controls-stub' }),
}))

function installApi(prefsFile: Record<string, unknown>) {
  const readJson = vi.fn().mockResolvedValue(
    prefsFile ? { exists: true, data: prefsFile } : { exists: false },
  )
  const writeJson = vi.fn().mockResolvedValue(undefined)
  ;(globalThis as any).window.api = {
    config: { readJson, writeJson },
    schedule: {
      sessionSlots: vi.fn().mockResolvedValue({ total: 3, inUse: 0, holders: [] }),
      setConfig: vi.fn().mockResolvedValue(undefined),
    },
  }
  return { readJson, writeJson }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
  delete (globalThis as any).window?.api
})

function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(createElement(SessionManagerConfig, {})))
  return container
}

describe('SessionManagerConfig — Behavior toggle', () => {
  it('renders unchecked when app-prefs.json has no openToHomeOnLaunch entry', async () => {
    installApi({})
    const el = mount()
    await flushAsync()
    const toggle = el.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('renders checked when app-prefs.json has openToHomeOnLaunch:true', async () => {
    installApi({ openToHomeOnLaunch: true })
    const el = mount()
    await flushAsync()
    const toggle = el.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('clicking the toggle writes openToHomeOnLaunch through config.writeJson and flips checked state', async () => {
    const { writeJson } = installApi({})
    const el = mount()
    await flushAsync()
    const toggle = el.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    act(() => { toggle.click() })
    await flushAsync()

    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(writeJson).toHaveBeenCalledWith(
      '~/.claude/session-manager/app-prefs.json',
      expect.objectContaining({ openToHomeOnLaunch: true }),
    )
  })

  it('rolls back the toggle when the write fails', async () => {
    installApi({})
    ;(globalThis as any).window.api.config.writeJson = vi.fn().mockRejectedValue(new Error('disk full'))
    const el = mount()
    await flushAsync()
    const toggle = el.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    act(() => { toggle.click() })
    await flushAsync()

    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })
})
