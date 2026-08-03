// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useBuilderEpic } from '../useBuilderEpic'
import { usePromptSessions } from '../../../state/promptSessions'
import { useChat } from '../../../state/chat'
import { fakePromptSessionsCreate } from '../../../testUtils/fakePromptSessionsCreate'

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
    await Promise.resolve()
  })
}

const BUILDER_PERSONA = { name: 'project-home-builder', description: 'Generates Project Pages.' }
const listPersonasMock = vi.fn().mockResolvedValue([BUILDER_PERSONA])

function Harness({ cwd }: { cwd: string }) {
  const { generate } = useBuilderEpic(cwd)
  return (
    <button type="button" onClick={() => void generate()}>
      Generate My Project Home
    </button>
  )
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

describe('useBuilderEpic', () => {
  it('creates a project-home-builder Epic and sends the opening prompt when none is active', async () => {
    ;(globalThis as any).window.api = {
      agents: { listPersonas: listPersonasMock },
      promptSessions: { create: fakePromptSessionsCreate(), onEventAppended: vi.fn() },
    }
    const el = mount(<Harness cwd={CWD} />)
    await flush()
    const btn = el.querySelector('button') as HTMLButtonElement
    act(() => btn.click())
    await flush()
    expect(createPromptSessionSpy).toHaveBeenCalledWith(
      CWD,
      expect.any(String),
      'project-home-builder',
      'ProjectHome',
      'project-home-builder',
    )
    expect(approveProposedSpy).toHaveBeenCalled()
    expect(sendSpy).toHaveBeenCalled()
  })

  it('navigates to an already-active project-home-builder Epic instead of creating a second one', async () => {
    ;(globalThis as any).window.api = { agents: { listPersonas: listPersonasMock } }
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
    const el = mount(<Harness cwd={CWD} />)
    await flush()
    const btn = el.querySelector('button') as HTMLButtonElement
    act(() => btn.click())
    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(navigateSpy).toHaveBeenCalled()
    window.removeEventListener('sm:navigate', navigateSpy)
  })
})
