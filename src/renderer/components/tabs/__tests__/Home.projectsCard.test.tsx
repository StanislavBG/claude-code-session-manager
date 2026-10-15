// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const known = vi.hoisted(() => ({ unresolved: 0 }))
vi.mock('../../../lib/useKnownProjects', async (orig) => {
  const actual = await orig<typeof import('../../../lib/useKnownProjects')>()
  return {
    ...actual,
    useKnownProjects: () => ({ projects: [], unresolvedWorktreeFolders: known.unresolved }),
  }
})

import { ProjectsCard } from '../Home'

let container: HTMLDivElement | null = null
let root: Root | null = null

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    encoded: `enc-${i + 1}`,
    name: `proj-${i + 1}`,
    cwd: `/home/bilko/Projects/proj-${i + 1}`,
    dotSeed: `seed-${i + 1}`,
    liveCount: 0,
    lastActivityMs: 0,
  }))

async function mount(n: number) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(ProjectsCard, { projectRows: rows(n) }))
    await Promise.resolve()
  })
  return container
}

const names = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('button[title]')).map((b) => b.getAttribute('title')!.split('/').pop())

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  known.unresolved = 0
})

describe('ProjectsCard', () => {
  it('pages 20 rows: 8 visible, range 1–8 of 20, Next shows rows 9–16', async () => {
    const el = await mount(20)
    expect(names(el)).toHaveLength(8)
    expect(el.querySelector('[data-testid="home-projects-pager-range"]')!.textContent).toBe('1–8 of 20')
    await act(async () => {
      el.querySelector('[data-testid="home-projects-pager-next"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    const second = names(el)
    expect(second).toHaveLength(8)
    expect(second[0]).toBe('proj-9')
    expect(second[7]).toBe('proj-16')
  })

  it('renders no pager for a short list', async () => {
    const el = await mount(3)
    expect(el.querySelector('[data-testid="home-projects-pager"]')).toBeNull()
  })

  it('shows the unresolved worktree line only when count > 0', async () => {
    known.unresolved = 3
    const el = await mount(2)
    expect(el.querySelector('[data-testid="home-projects-unresolved"]')!.textContent).toBe(
      '3 worktree folders not matched to a project',
    )
  })

  it('omits the unresolved line when zero', async () => {
    const el = await mount(2)
    expect(el.querySelector('[data-testid="home-projects-unresolved"]')).toBeNull()
  })
})
