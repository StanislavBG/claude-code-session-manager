// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentsCard } from '../Home'
import { useConfig } from '../../../state/config'

/**
 * Home's Agents card caption now carries a MACHINE-WIDE effort readout
 * (models readout PRD, sibling of the effectiveModelInfo resolver) — the
 * settings.json scope chain read with no cwd, so it's the global/user-scope
 * default rather than any one project's overlay.
 */

function installWindowApiMock(userSettings: Record<string, unknown> | null) {
  const raw = userSettings ? JSON.stringify(userSettings) : ''
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue('/home/bilko') },
    config: {
      readJson: vi.fn().mockResolvedValue(
        userSettings
          ? { exists: true, raw, data: userSettings, parseError: null, mtimeMs: 0, error: null }
          : { exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: null }
      ),
      watch: vi.fn(),
      unwatch: vi.fn(),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(AgentsCard))
    await Promise.resolve()
    await Promise.resolve()
  })
  return container
}

beforeEach(() => {
  useConfig.setState({ files: {}, watchRefs: {} })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('Home AgentsCard', () => {
  it('renders "model default" when no scope sets an effort level', async () => {
    installWindowApiMock(null)
    const el = await mount()
    const caption = el.querySelector('[data-testid="home-agents-effort"]')
    expect(caption?.textContent).toContain('model default')
  })

  it('renders the effort level and its winning scope when user settings.json sets one', async () => {
    installWindowApiMock({ effortLevel: 'high' })
    const el = await mount()
    const caption = el.querySelector('[data-testid="home-agents-effort"]')
    expect(caption?.textContent).toContain('high')
    expect(caption?.textContent).toContain('user settings.json')
  })
})
