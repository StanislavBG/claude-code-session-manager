// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'
import type { SeedStatus } from '../../../../preload/api'

/**
 * The Plugins tab surfaces a dismissible banner when a first-boot seeder is
 * 'exhausted', naming which seeder failed and its manual fix. 'done'/'pending'
 * seeders must render nothing (no banner on the happy path).
 */

const HOME = '/home/test'

function installWindowApiMock(seedStatus: SeedStatus) {
  const api = {
    app: {
      homeDir: vi.fn().mockResolvedValue(HOME),
      seedStatus: vi.fn().mockResolvedValue(seedStatus),
    },
    config: {
      exists: vi.fn().mockResolvedValue(false),
      readJson: vi.fn().mockResolvedValue({ exists: false, parseError: false, data: null, mtimeMs: 0, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

const ALL_PENDING: SeedStatus = {
  'dev-plugin': { status: 'pending', fix: 'fix-dev-plugin' },
  'scheduler-mcp': { status: 'pending', fix: 'fix-scheduler-mcp' },
  'agent-personas': { status: 'pending', fix: 'fix-agent-personas' },
}

const ALL_DONE: SeedStatus = {
  'dev-plugin': { status: 'done', fix: 'fix-dev-plugin' },
  'scheduler-mcp': { status: 'done', fix: 'fix-scheduler-mcp' },
  'agent-personas': { status: 'done', fix: 'fix-agent-personas' },
}

const SCHEDULER_MCP_EXHAUSTED: SeedStatus = {
  'dev-plugin': { status: 'done', fix: 'fix-dev-plugin' },
  'scheduler-mcp': { status: 'exhausted', fix: 'claude mcp add session-manager-scheduler --scope user -- node /abs/path/scheduler-mcp-server.cjs' },
  'agent-personas': { status: 'pending', fix: 'fix-agent-personas' },
}

const flush = () => flushAsync(4)

describe('Plugins seed-status banner', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('renders nothing when every seeder is pending', async () => {
    installWindowApiMock(ALL_PENDING)
    const { Plugins } = await import('../Plugins')
    const root = createRoot(container)
    act(() => {
      root.render(createElement(Plugins))
    })
    await flush()

    expect(container.textContent ?? '').not.toContain('setup failed')
    act(() => root.unmount())
  })

  it('renders nothing when every seeder is done', async () => {
    installWindowApiMock(ALL_DONE)
    const { Plugins } = await import('../Plugins')
    const root = createRoot(container)
    act(() => {
      root.render(createElement(Plugins))
    })
    await flush()

    expect(container.textContent ?? '').not.toContain('setup failed')
    act(() => root.unmount())
  })

  it('names the exhausted seeder and its manual fix command, and can be dismissed', async () => {
    installWindowApiMock(SCHEDULER_MCP_EXHAUSTED)
    const { Plugins } = await import('../Plugins')
    const root = createRoot(container)
    act(() => {
      root.render(createElement(Plugins))
    })
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('Scheduler MCP server')
    expect(text).toContain('setup failed')
    expect(text).toContain('claude mcp add session-manager-scheduler --scope user -- node /abs/path/scheduler-mcp-server.cjs')
    // Only the exhausted seeder gets a banner row — done/pending ones don't.
    expect(text).not.toContain('session-manager-dev plugin setup failed')
    expect(text).not.toContain('Agent personas (Architect, Dev Lead) setup failed')

    const dismissBtn = container.querySelector('button[aria-label="Dismiss Scheduler MCP server warning"]') as HTMLButtonElement
    expect(dismissBtn).toBeTruthy()
    act(() => {
      dismissBtn.click()
    })
    await flush()

    expect(container.textContent ?? '').not.toContain('setup failed')
    act(() => root.unmount())
  })
})
