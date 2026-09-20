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
    projectPages: { get: vi.fn().mockResolvedValue({ output: null }) },
    agents: { listPersonas: vi.fn().mockResolvedValue([]) },
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

  it('renders no hand-written live blocks for an active tab without home.html', async () => {
    useSessions.setState({ tabs: [{ id: 't1', cwd: '/proj' } as any], activeTabId: 't1' })
    ;(globalThis as any).window.api.projectPages = {
      get: vi.fn().mockResolvedValue({ html: null, mtimeMs: null }),
      watch: vi.fn().mockResolvedValue(undefined),
      unwatch: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn().mockReturnValue(() => {}),
    }
    await act(async () => {
      mount(<ProjectHome />)
    })
    const text = container?.textContent ?? ''
    expect(text).not.toContain('What is in flight')
    expect(text).not.toContain('Waiting on you')
    expect(text).not.toContain('Agent tools')
  })
})
