// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { useBuilderEpic, BUILDER_AGENT_NAME } from '../useBuilderEpic'
import { usePromptSessions } from '../../../state/promptSessions'
import { useChat } from '../../../state/chat'
import { useToast } from '../../../state/toast'
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
const READY = { ok: true, checks: [] }

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
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
})

describe('useBuilderEpic', () => {
  it('resolves the persona seeded on a fresh install (src/seed/agents/<BUILDER_AGENT_NAME>.md exists)', () => {
    const seededPath = path.join(__dirname, '..', '..', '..', '..', 'seed', 'agents', `${BUILDER_AGENT_NAME}.md`)
    expect(fs.existsSync(seededPath)).toBe(true)
  })

  it('creates a project-home-builder Epic and sends the opening prompt when none is active', async () => {
    ;(globalThis as any).window.api = {
      agents: { listPersonas: listPersonasMock },
      app: { delegationReadiness: vi.fn().mockResolvedValue(READY) },
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

  it('refuses and creates NO Epic when the project-home-builder persona is not installed', async () => {
    ;(globalThis as any).window.api = {
      agents: { listPersonas: vi.fn().mockResolvedValue([]) },
      app: { delegationReadiness: vi.fn().mockResolvedValue(READY) },
      promptSessions: { create: fakePromptSessionsCreate(), onEventAppended: vi.fn() },
    }
    const el = mount(<Harness cwd={CWD} />)
    await flush()
    const btn = el.querySelector('button') as HTMLButtonElement
    act(() => btn.click())
    await flush()
    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(approveProposedSpy).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
    expect(
      useToast.getState().toasts.some((t) => t.kind === 'error' && t.message.includes(BUILDER_AGENT_NAME)),
    ).toBe(true)
  })

  it('refuses and creates NO Epic when delegation readiness reports unavailable', async () => {
    const notReady = {
      ok: false,
      checks: [
        {
          id: 'scheduler-mcp-live',
          label: 'Scheduler MCP server answers tools/list',
          ok: false,
          detail: 'timeout',
          fix: null,
        },
      ],
    }
    ;(globalThis as any).window.api = {
      agents: { listPersonas: listPersonasMock },
      app: { delegationReadiness: vi.fn().mockResolvedValue(notReady) },
      promptSessions: { create: fakePromptSessionsCreate(), onEventAppended: vi.fn() },
    }
    const el = mount(<Harness cwd={CWD} />)
    await flush()
    const btn = el.querySelector('button') as HTMLButtonElement
    act(() => btn.click())
    await flush()
    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(approveProposedSpy).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
    expect(
      useToast
        .getState()
        .toasts.some((t) => t.kind === 'error' && t.message.includes('Scheduler MCP server answers tools/list')),
    ).toBe(true)
  })

  it('navigates to an already-active project-home-builder Epic instead of creating a second one', async () => {
    ;(globalThis as any).window.api = {
      agents: { listPersonas: listPersonasMock },
      app: { delegationReadiness: vi.fn().mockResolvedValue(READY) },
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
    const el = mount(<Harness cwd={CWD} />)
    await flush()
    const btn = el.querySelector('button') as HTMLButtonElement
    act(() => btn.click())
    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(navigateSpy).toHaveBeenCalled()
    window.removeEventListener('sm:navigate', navigateSpy)
  })
})
