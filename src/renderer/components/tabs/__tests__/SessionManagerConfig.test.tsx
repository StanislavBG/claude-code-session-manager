// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { SessionManagerConfig } from '../SessionManagerConfig'
import { flushAsync } from '../../../testUtils/domFlush'

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
      worktreeBase: vi.fn().mockResolvedValue('/home/u/.local/state/session-manager'),
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

describe('SessionManagerConfig', () => {
  it('no longer renders the open-to-Home toggle (moved to AppSettings › Startup)', async () => {
    installApi({})
    const el = mount()
    await flushAsync()
    expect(el.querySelector('button[role="switch"]')).toBeNull()
    expect(el.textContent).not.toContain('Open to Home on launch')
  })

  it('renders no Global Controls summary cards (each duplicated a Home page counter)', async () => {
    installApi({})
    const el = mount()
    await flushAsync()
    expect(el.textContent).not.toContain('Global Controls')
    expect(el.querySelectorAll('button')).toHaveLength(0)
  })

  it('shows the resolved worktree base in the On disk list', async () => {
    installApi({})
    const el = mount()
    await flushAsync()
    expect(el.querySelector('[data-testid="worktree-base-path"]')?.textContent).toContain('/home/u/.local/state/session-manager/session-manager-epic-worktrees/')
  })
})
