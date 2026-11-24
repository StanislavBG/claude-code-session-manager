// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

vi.mock('../../../lib/useKnownProjects', async (orig) => {
  const actual = await orig<typeof import('../../../lib/useKnownProjects')>()
  return { ...actual, useKnownProjects: () => ({ projects: [], recentSessions: [], loading: false }) }
})

import { Home } from '../Home'

/**
 * The Dashboard is view-only (owner 2026-11-22, decided 2026-11-23 in Epic
 * 9f2682ff): the hero carries no Interactions legend or New epic button, and
 * the page has no Reference section (agent tools, Agents card).
 */

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  const EMPTY_JSON = { ok: true, exists: false, raw: '', data: null, parseError: null, error: null, mtimeMs: 0 }
  ;(window as unknown as { api: unknown }).api = new Proxy({}, { get: () => new Proxy(() => Promise.resolve(null), { get: (_t, m) => (m === 'readJson' ? () => Promise.resolve(EMPTY_JSON) : () => Promise.resolve(null)) }) })
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(Home, {}))
    await Promise.resolve()
    await Promise.resolve()
  })
  return container
}

describe('Home is view-only', () => {
  it('renders none of the removed hero controls or the Reference section', async () => {
    const el = await mount()
    const header = el.querySelector('header')!
    expect(header).toBeTruthy()
    const labels = Array.from(header.querySelectorAll('button')).map((b) => b.textContent?.trim())
    expect(labels).not.toContain('Interactions')
    expect(labels).not.toContain('Hide interactions')
    expect(labels).not.toContain('New epic')
    expect(el.textContent).not.toContain('Needs-you row')
    expect(el.querySelector('[data-testid="home-reference"]')).toBeNull()
    expect(el.querySelector('[data-testid="home-agent-tools"]')).toBeNull()
    expect(el.textContent).not.toContain('Reference')
  })

  it('keeps the greeting, Refresh and All history in the hero', async () => {
    const el = await mount()
    const header = el.querySelector('header')!
    expect(header.querySelector('h1')?.textContent).toMatch(/^(Up late|Good morning|Good afternoon|Good evening)\./)
    expect(header.querySelector('[data-testid="home-refresh"]')).toBeTruthy()
    const labels = Array.from(header.querySelectorAll('button')).map((b) => b.textContent?.trim())
    expect(labels).toContain('All history')
  })
})
