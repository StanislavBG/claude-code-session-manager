// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ProjectsWorkspace } from '../ProjectsWorkspace'
import { useSessions } from '../../../state/sessions'
import { useLayout } from '../../../state/layout'
import { flushAsync } from '../../../testUtils/domFlush'

/**
 * File Explorer is now a BOTH-face screen (see lib/navGroups.ts) reachable
 * from both the Home and Project sidebars. Its starting root folder must
 * differ by face: Project face roots at the active tab's cwd (unchanged);
 * Home face roots at the OS home dir and must never depend on activeTab —
 * that's the distinction the user asked for ("what must differ is the
 * starting location of root folder").
 */

vi.mock('../../layout/FileTree', () => ({
  FileTree: ({ cwd }: { cwd: string }) => <div data-testid="file-tree-stub" data-cwd={cwd} />,
}))

vi.mock('../EditorView', () => ({
  EditorView: () => <div data-testid="editor-view-stub" />,
}))

vi.mock('../../../lib/useKnownProjects', () => ({
  useKnownProjects: () => ({
    rows: [],
    enriched: {},
    openInSession: vi.fn(),
    archiveProject: vi.fn(),
  }),
  candidatePath: (encoded: string) => encoded.replace(/-/g, '/'),
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  useSessions.setState({ tabs: [], activeTabId: null })
  useLayout.setState({ navFace: 'project' })
  ;(globalThis as any).window.api = {
    app: { homeDir: vi.fn().mockResolvedValue('/home/testuser') },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.restoreAllMocks()
})

async function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  await flushAsync()
  return container
}

describe('ProjectsWorkspace root folder by navFace', () => {
  it('roots at the active tab cwd on the Project face', async () => {
    useSessions.setState({
      tabs: [{ id: 't1', cwd: '/home/testuser/my-project', label: 'my-project', status: 'running', pid: 1 } as any],
      activeTabId: 't1',
    })
    useLayout.setState({ navFace: 'project' })
    const el = await mount(<ProjectsWorkspace />)
    const stub = el.querySelector('[data-testid="file-tree-stub"]')
    expect(stub?.getAttribute('data-cwd')).toBe('/home/testuser/my-project')
  })

  it('roots at the OS home dir on the Home face, even with a project tab open', async () => {
    useSessions.setState({
      tabs: [{ id: 't1', cwd: '/home/testuser/my-project', label: 'my-project', status: 'running', pid: 1 } as any],
      activeTabId: 't1',
    })
    useLayout.setState({ navFace: 'home' })
    const el = await mount(<ProjectsWorkspace />)
    const stub = el.querySelector('[data-testid="file-tree-stub"]')
    expect(stub?.getAttribute('data-cwd')).toBe('/home/testuser')
  })

  it('shows "No session selected" on the Project face with no active tab, not a home-dir tree', async () => {
    useSessions.setState({ tabs: [], activeTabId: null })
    useLayout.setState({ navFace: 'project' })
    const el = await mount(<ProjectsWorkspace />)
    expect(el.textContent).toContain('No session selected.')
    expect(el.querySelector('[data-testid="file-tree-stub"]')).toBeNull()
  })

  it('does not dead-end on the Home face with no active tab — resolves to the home dir instead', async () => {
    useSessions.setState({ tabs: [], activeTabId: null })
    useLayout.setState({ navFace: 'home' })
    const el = await mount(<ProjectsWorkspace />)
    const stub = el.querySelector('[data-testid="file-tree-stub"]')
    expect(stub?.getAttribute('data-cwd')).toBe('/home/testuser')
  })
})
