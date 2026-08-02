// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, afterEach } from 'vitest'
import { AlmanacSidebar } from '../AlmanacSidebar'
import { useScheduleState } from '../../../state/scheduleState'
import { useSessions } from '../../../state/sessions'
import { useLayout } from '../../../state/layout'

// AlmanacSidebar persists rail/collapse state to localStorage; jsdom provides
// a real localStorage so no mocking needed, but clear it between tests so one
// test's rail toggle doesn't leak into the next.
afterEach(() => {
  localStorage.clear()
  useScheduleState.setState({ snapshot: null, loaded: false })
  useSessions.setState({ tabs: [], activeTabId: null })
  useLayout.setState({ navFace: 'home' })
})

/** Seed a scheduler snapshot with one running job per given cwd. */
function seedRunningJobs(cwds: string[]) {
  const jobs = cwds.map((cwd, i) => ({
    slug: `job-${i}`,
    title: `Job ${i}`,
    cwd,
    status: 'running',
    parallelGroup: 0,
    estimateMinutes: null,
    bodyPreview: '',
    runId: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
  }))
  useScheduleState.setState({ snapshot: { jobs } as never, loaded: true })
}

function seedActiveTab(cwd: string | null) {
  if (cwd === null) {
    useSessions.setState({ tabs: [], activeTabId: null })
    return
  }
  useSessions.setState({
    tabs: [{ id: 'tab-1', cwd } as never],
    activeTabId: 'tab-1',
  })
}

function schedulerDotCount(container: HTMLElement): number {
  return container.querySelectorAll('[title="live activity"]').length
}

function mount(active: 'overview' | 'scheduler' = 'overview') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      createElement(AlmanacSidebar, {
        active,
        onNavigate: () => {},
        onNewSession: () => {},
      }),
    )
  })
  return { container, root }
}

describe('AlmanacSidebar', () => {
  it('renders each row label alongside its hint text in the non-rail (expanded) layout', () => {
    // Project face (navFace is real state now, not derived from `active` —
    // see state/layout.ts) so both project-only (Search) and both-face
    // (Scheduler) rows are present.
    seedActiveTab('/tmp/project')
    useLayout.setState({ navFace: 'project' })
    const { container, root } = mount('scheduler')
    try {
      const nav = container.querySelector('[data-testid="tour-leftnav"]')
      expect(nav).not.toBeNull()
      const text = nav?.textContent ?? ''

      // Workspace row: label + its navGroups.ts hint should both be visible
      // text. Scheduler renders the same "Scheduler" label + hint on both
      // faces now — no per-face labelByFace override.
      expect(text).toContain('Scheduler')
      expect(text).toContain("Global policy + this project's live PRD queue")

      // Tools row: label + its hint should both be visible text.
      expect(text).toContain('Search')
      expect(text).toContain('⌘P file · ⌘⇧F content')

      // Group headers show their one-line description.
      expect(text).toContain('Workspace')
      expect(text).toContain('Where you do the work — sessions, files, and everything currently running.')
      expect(text).toContain('Configure')
      expect(text).toContain('How Claude behaves — changes here apply to every session you start.')
      expect(text).toContain('Tools')
      expect(text).toContain('One-off utilities — not configuration, just things you reach for sometimes.')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('renders icon-only rows with no visible label/hint text in rail (collapsed) mode', () => {
    localStorage.setItem('sm.almanac.sidebarCollapsed', '1')
    const { container, root } = mount()
    try {
      const nav = container.querySelector('[data-testid="tour-leftnav"]')
      expect(nav).not.toBeNull()
      const text = (nav?.textContent ?? '').trim()

      // Rail mode renders icons (SVGs) only — no row label/hint/group-header text.
      expect(text).not.toContain('Scheduler')
      expect(text).not.toContain('Author PRDs')
      expect(text).not.toContain('Workspace')
      expect(text).not.toContain('Where you do the work')

      // But the icon-bearing buttons are still present.
      expect(nav?.querySelectorAll('svg').length).toBeGreaterThan(0)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  // The Scheduler nav dot is scoped to the active TAB's project (TAB → EPIC →
  // PRD domain model) — a job running in a different project must not light up
  // this project's row.
  describe('scheduler live dot project scoping', () => {
    it('lights up when a running job belongs to the active tab\'s project', () => {
      seedActiveTab('/home/u/Projects/alpha')
      seedRunningJobs(['/home/u/Projects/alpha'])
      const { container, root } = mount()
      try {
        expect(schedulerDotCount(container)).toBe(1)
      } finally {
        act(() => root.unmount())
        container.remove()
      }
    })

    it('stays dark when the only running job belongs to another project', () => {
      seedActiveTab('/home/u/Projects/alpha')
      seedRunningJobs(['/home/u/Projects/beta'])
      const { container, root } = mount()
      try {
        expect(schedulerDotCount(container)).toBe(0)
      } finally {
        act(() => root.unmount())
        container.remove()
      }
    })

    it('falls back to machine-wide when there is no active tab', () => {
      seedActiveTab(null)
      seedRunningJobs(['/home/u/Projects/beta'])
      const { container, root } = mount()
      try {
        expect(schedulerDotCount(container)).toBe(1)
      } finally {
        act(() => root.unmount())
        container.remove()
      }
    })

    it('ignores running jobs with a null cwd when a project is scoped', () => {
      seedActiveTab('/home/u/Projects/alpha')
      useScheduleState.setState({
        snapshot: { jobs: [{ slug: 'j', status: 'running', cwd: null }] } as never,
        loaded: true,
      })
      const { container, root } = mount()
      try {
        expect(schedulerDotCount(container)).toBe(0)
      } finally {
        act(() => root.unmount())
        container.remove()
      }
    })
  })
})
