// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const recent = Array.from({ length: 12 }, (_, i) => ({
  path: `/t/${i}.jsonl`,
  sessionId: `sess${String(i).padStart(4, '0')}-aaaa`,
  projectEncoded: '-home-x-proj',
  mtimeMs: 1000 + i,
  sizeBytes: 2048,
}))

vi.mock('../../../lib/useKnownProjects', async (orig) => {
  const actual = await orig<typeof import('../../../lib/useKnownProjects')>()
  return { ...actual, useKnownProjects: () => ({ projects: [], recentSessions: recent, loading: false }) }
})

import { NeedsYouSection, ActiveSessionsCard, RecentSessionsCard } from '../Home'

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(node)
    await Promise.resolve()
    await Promise.resolve()
  })
  return container
}

beforeEach(() => {
  const holders = Array.from({ length: 7 }, (_, i) => ({ owner: `chat:epic-${i}`, at: '2026-08-02T20:00:00.000Z' }))
  ;(window as unknown as { api: unknown }).api = {
    schedule: {
      sessionSlots: vi.fn().mockResolvedValue({ total: 10, inUse: 7, holders, min: 0, max: 10, default: 5, envOverride: false }),
    },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

const range = (el: HTMLElement, prefix: string) => el.querySelector(`[data-testid="${prefix}-range"]`)?.textContent

describe('Home paged panels', () => {
  it('NeedsYouSection shows 4 rows per page and collapses an open row on page change', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: `r${i}`, kind: 'needs-input' as const, label: `Row ${i}`, detail: 'd', meta: `meta-${i}`,
      project: null, epicId: `e${i}`, jobSlug: null,
    }))
    const el = await mount(createElement(NeedsYouSection, { rows }))
    expect(el.textContent).toContain('Row 3')
    expect(el.textContent).not.toContain('Row 4')
    expect(range(el, 'home-needs-pager')).toBe('1–4 of 6')
    const first = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Row 0'))!
    await act(async () => { first.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(el.textContent).toContain('meta-0')
    const next = el.querySelector('[data-testid="home-needs-pager-next"]')!
    await act(async () => { next.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(range(el, 'home-needs-pager')).toBe('5–6 of 6')
    expect(el.textContent).toContain('Row 5')
    expect(el.textContent).not.toContain('meta-0')
  })

  it('ActiveSessionsCard shows 5 rows per page', async () => {
    const el = await mount(createElement(ActiveSessionsCard, {}))
    expect(el.textContent).toContain('chat:epic-4')
    expect(el.textContent).not.toContain('chat:epic-5')
    expect(range(el, 'home-active-pager')).toBe('1–5 of 7')
  })

  it('RecentSessionsCard pages all recent sessions 5 per page', async () => {
    const el = await mount(createElement(RecentSessionsCard, {}))
    expect(el.textContent).toContain('sess0004')
    expect(el.textContent).not.toContain('sess0005')
    expect(range(el, 'home-recent-pager')).toBe('1–5 of 12')
  })
})
