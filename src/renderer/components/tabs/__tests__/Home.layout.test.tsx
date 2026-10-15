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

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = new Proxy({}, { get: () => new Proxy(() => Promise.resolve(null), { get: () => () => Promise.resolve(null) }) })
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

describe('Home layout', () => {
  it('lays out six panels in a grid and collapses reference cards', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(Home, {}))
      await Promise.resolve()
      await Promise.resolve()
    })
    const grid = container.querySelector('[data-testid="home-panel-grid"]')!
    expect(grid).toBeTruthy()
    expect(grid.children.length).toBe(6)
    const text = Array.from(grid.children).map((c) => c.textContent ?? '')
    expect(text[1]).toContain('Projects')
    expect(text[2]).toContain('Queued')
    expect(text[3]).toContain('Needs you')
    expect(text[4]).toContain('Active sessions')
    expect(text[5]).toContain('Recent sessions')
    const ref = container.querySelector('details[data-testid="home-reference"]') as HTMLDetailsElement
    expect(ref).toBeTruthy()
    expect(ref.open).toBe(false)
    expect(ref.querySelector('[data-testid="home-agent-tools"]')).toBeTruthy()
    expect(ref.querySelector('[data-testid="home-data-model-card"]')).toBeTruthy()
  })
})
