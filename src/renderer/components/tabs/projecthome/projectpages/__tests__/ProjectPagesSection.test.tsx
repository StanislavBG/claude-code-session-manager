// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ProjectPagesSection } from '../ProjectPagesSection'
import { usePromptSessions } from '../../../../../state/promptSessions'
import { useChat } from '../../../../../state/chat'

const CWD = '/home/bilko/Projects/alpha'

const createPromptSessionSpy = vi.fn(usePromptSessions.getState().createPromptSession)
const approveProposedSpy = vi.fn(usePromptSessions.getState().approveProposed)
const sendSpy = vi.fn()

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  usePromptSessions.setState({ sessions: {}, events: {} })
  usePromptSessions.setState({ createPromptSession: createPromptSessionSpy, approveProposed: approveProposedSpy })
  createPromptSessionSpy.mockClear()
  approveProposedSpy.mockClear()
  useChat.setState({ send: sendSpy })
  sendSpy.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.restoreAllMocks()
})

describe('ProjectPagesSection', () => {
  it('renders the empty state when projectPages.get resolves output: null', async () => {
    ;(globalThis as any).window.api = {
      projectPages: { get: vi.fn().mockResolvedValue({ output: null }) },
    }
    const el = mount(<ProjectPagesSection cwd={CWD} />)
    await flush()
    expect(el.textContent).toContain('No Project Pages yet')
    expect(el.textContent).toContain('Generate Now')
  })

  it('renders the iframe display with the marketing html as srcDoc when output is present', async () => {
    ;(globalThis as any).window.api = {
      projectPages: {
        get: vi.fn().mockResolvedValue({
          output: {
            marketing: '<!DOCTYPE html><html><body>MARKETING</body></html>',
            feature: '<!DOCTYPE html><html><body>FEATURE</body></html>',
            architecture: '<!DOCTYPE html><html><body>ARCHITECTURE</body></html>',
            generatedAt: '2026-08-02T00:00:00.000Z',
          },
        }),
      },
    }
    const el = mount(<ProjectPagesSection cwd={CWD} />)
    await flush()
    const iframe = el.querySelector('iframe') as HTMLIFrameElement
    expect(iframe).toBeTruthy()
    expect(iframe.getAttribute('srcdoc')).toContain('MARKETING')
    expect(el.textContent).toContain('Regenerate')
  })

  it('clicking Generate Now with no existing project-home-builder Epic calls createPromptSession with tag project-home-builder', async () => {
    ;(globalThis as any).window.api = {
      projectPages: { get: vi.fn().mockResolvedValue({ output: null }) },
    }
    const el = mount(<ProjectPagesSection cwd={CWD} />)
    await flush()
    const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Generate Now') as HTMLButtonElement
    act(() => btn.click())
    expect(createPromptSessionSpy).toHaveBeenCalledWith(CWD, expect.any(String), 'project-home-builder', 'ProjectPagesSection')
    expect(approveProposedSpy).toHaveBeenCalled()
    expect(sendSpy).toHaveBeenCalled()
  })

  it('clicking Generate Now when a project-home-builder Epic is already active navigates to it instead of creating a second one', async () => {
    ;(globalThis as any).window.api = {
      projectPages: { get: vi.fn().mockResolvedValue({ output: null }) },
    }
    usePromptSessions.setState({
      sessions: {
        'existing-epic': {
          id: 'existing-epic',
          cwd: CWD,
          goalText: 'Generate pages',
          claudeSessionId: 'sess-1',
          status: 'active',
          createdAt: '2026-08-02T00:00:00.000Z',
          completedAt: null,
          tag: 'project-home-builder',
        } as any,
      },
    })
    const navigateSpy = vi.fn()
    window.addEventListener('sm:navigate', navigateSpy)
    const el = mount(<ProjectPagesSection cwd={CWD} />)
    await flush()
    const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Generate Now') as HTMLButtonElement
    act(() => btn.click())
    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(navigateSpy).toHaveBeenCalled()
    window.removeEventListener('sm:navigate', navigateSpy)
  })
})
