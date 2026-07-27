// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, afterEach } from 'vitest'
import { AlmanacSidebar } from '../AlmanacSidebar'

// AlmanacSidebar persists rail/collapse state to localStorage; jsdom provides
// a real localStorage so no mocking needed, but clear it between tests so one
// test's rail toggle doesn't leak into the next.
afterEach(() => {
  localStorage.clear()
})

function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      createElement(AlmanacSidebar, {
        active: 'overview',
        onNavigate: () => {},
        onNewSession: () => {},
      }),
    )
  })
  return { container, root }
}

describe('AlmanacSidebar', () => {
  it('renders each row label alongside its hint text in the non-rail (expanded) layout', () => {
    const { container, root } = mount()
    try {
      const nav = container.querySelector('[data-testid="tour-leftnav"]')
      expect(nav).not.toBeNull()
      const text = nav?.textContent ?? ''

      // Workspace row: label + its navGroups.ts hint should both be visible text.
      expect(text).toContain('Scheduler')
      expect(text).toContain('Author PRDs + run them as claude -p jobs')

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
})
