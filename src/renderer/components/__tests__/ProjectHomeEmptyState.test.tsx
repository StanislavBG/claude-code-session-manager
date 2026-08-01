// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ProjectHome } from '../tabs/projecthome/ProjectHome'
import { useSessions } from '../../state/sessions'

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  useSessions.setState({ tabs: [], activeTabId: null })
  ;(globalThis as any).window.api = {
    schedule: { listPrds: vi.fn().mockResolvedValue([]) },
    projectBrief: { get: vi.fn().mockResolvedValue({ brief: null, sources: [] }) },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.restoreAllMocks()
})

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

describe('ProjectHome with no active tab', () => {
  it('renders the empty state instead of throwing on activeTab.cwd', () => {
    expect(() => mount(<ProjectHome />)).not.toThrow()
    expect(container?.textContent).toContain('Open a project to see its brief')
  })
})
