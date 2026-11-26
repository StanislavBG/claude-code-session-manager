// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

/**
 * Dashboard refresh wiring: Home adopts useDashboardRefresh, and its bar
 * renders a Refresh button plus an 'Updated <ago>' / 'Refresh failed' stamp.
 */

const refreshState = vi.hoisted(() => ({
  value: {
    refresh: (() => {}) as () => void,
    refreshing: false,
    lastRefreshedAt: null as number | null,
    failedSources: [] as string[],
  },
}))

vi.mock('../../../lib/useDashboardRefresh', () => ({
  DASHBOARD_VISIT_MIN_GAP_MS: 30_000,
  useDashboardRefresh: () => refreshState.value,
}))

vi.mock('../../../lib/useKnownProjects', async (orig) => {
  const actual = await orig<typeof import('../../../lib/useKnownProjects')>()
  return { ...actual, useKnownProjects: () => ({ projects: [], recentSessions: [], loading: false }) }
})

import { Home, GuildHallBar } from '../Home'

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  const EMPTY_JSON = { ok: true, exists: false, raw: '', data: null, parseError: null, error: null, mtimeMs: 0 }
  ;(window as unknown as { api: unknown }).api = new Proxy({}, { get: () => new Proxy(() => Promise.resolve(null), { get: (_t, m) => (m === 'readJson' ? () => Promise.resolve(EMPTY_JSON) : () => Promise.resolve(null)) }) })
  refreshState.value = { refresh: () => {}, refreshing: false, lastRefreshedAt: null, failedSources: [] }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  vi.useRealTimers()
})

async function render(el: ReturnType<typeof createElement>) {
  await act(async () => {
    root!.render(el)
    await Promise.resolve()
    await Promise.resolve()
  })
}

function header(props: Partial<{ onRefresh: () => void; refreshing: boolean; lastRefreshedAt: number | null; failedSources: string[] }>) {
  return createElement(GuildHallBar, {
    inUse: 0, total: 5, questCount: 0, questOpen: false, onToggleQuest: () => {}, ...props,
  })
}

const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null

describe('Home refresh', () => {
  it('clicking home-refresh calls refresh()', async () => {
    const refresh = vi.fn()
    refreshState.value = { ...refreshState.value, refresh, lastRefreshedAt: Date.now() }
    await render(createElement(Home, {}))
    const btn = q('home-refresh')!
    expect(btn).toBeTruthy()
    expect(btn.textContent).toBe('Refresh')
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('refreshing disables the button and reads Refreshing…', async () => {
    await render(header({ onRefresh: () => {}, refreshing: true, lastRefreshedAt: Date.now(), failedSources: [] }))
    const btn = q('home-refresh')!
    expect(btn.disabled).toBe(true)
    expect(btn.textContent).toBe('Refreshing…')
  })

  it('stamp shows Updated after a success', async () => {
    await render(header({ onRefresh: () => {}, refreshing: false, lastRefreshedAt: Date.now() - 5_000, failedSources: [] }))
    expect(q('home-updated-at')!.textContent).toMatch(/^Updated /)
  })

  it('stamp shows the failed sources', async () => {
    await render(header({ onRefresh: () => {}, refreshing: false, lastRefreshedAt: null, failedSources: ['projects'] }))
    expect(q('home-updated-at')!.textContent).toBe('Refresh failed: projects')
  })

  it('stamp is absent before the first refresh', async () => {
    await render(header({ onRefresh: () => {}, refreshing: false, lastRefreshedAt: null, failedSources: [] }))
    expect(q('home-updated-at')).toBeNull()
    expect(container!.textContent).not.toContain('Updated never')
  })

  it('without onRefresh neither the button nor the stamp renders', async () => {
    await render(header({ lastRefreshedAt: Date.now() }))
    expect(q('home-refresh')).toBeNull()
    expect(q('home-updated-at')).toBeNull()
  })
})
