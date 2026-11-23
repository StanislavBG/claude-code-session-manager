// @vitest-environment jsdom
/**
 * SessionActionsBar "Update agent" — re-pins the selected Epic's persona
 * snapshot via epic:refresh-agent-snapshot and toasts the outcome.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SessionActionsBar } from '../SessionActionsBar'
import { __resetMacrosCacheForTests } from '../../../lib/useMacros'
import { usePromptSessions } from '../../../state/promptSessions'
import { useSessions } from '../../../state/sessions'
import { useToast } from '../../../state/toast'

const CWD = '/home/bilko/Projects/alpha'
const EPIC = 'epic-1'

const refreshAgentSnapshot = vi.fn()
;(globalThis as any).window.api = {
  agents: { listPersonas: vi.fn(async () => []), onChanged: vi.fn(() => () => {}) },
  macros: { list: vi.fn(async () => []), onChanged: vi.fn(() => () => {}) },
  promptSessions: { refreshAgentSnapshot, onEventAppended: vi.fn() },
}

let container: HTMLDivElement | null = null
let root: Root | null = null
const showSpy = vi.fn()

async function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(el) })
  return container
}
const btn = (el: HTMLElement) => el.querySelector('[data-testid="epic-refresh-agent"]') as HTMLButtonElement | null

beforeEach(() => {
  __resetMacrosCacheForTests()
  refreshAgentSnapshot.mockReset()
  showSpy.mockReset()
  useToast.setState({ show: showSpy } as any)
  useSessions.setState({ tabs: [{ id: 'tab-1', cwd: CWD } as any], activeTabId: 'tab-1' })
  usePromptSessions.setState({
    sessions: { [EPIC]: { id: EPIC, cwd: CWD, agentSnapshotId: 'old' } as any },
    events: {},
  })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('SessionActionsBar — Update agent', () => {
  it('is absent when no Epic is selected', async () => {
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />)
    expect(btn(el)).toBeNull()
  })

  it('calls the IPC with the Epic id and toasts success', async () => {
    refreshAgentSnapshot.mockResolvedValue({
      ok: true, changed: true, from: 'old', to: 'new', session: { id: EPIC, cwd: CWD, agentSnapshotId: 'new' },
    })
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} epicId={EPIC} />)
    expect(btn(el)?.textContent).toBe('Update agent')
    await act(async () => { btn(el)!.click() })
    expect(refreshAgentSnapshot).toHaveBeenCalledWith({ cwd: CWD, epicId: EPIC })
    expect(showSpy).toHaveBeenCalledWith('info', expect.stringMatching(/updated/i))
    expect((usePromptSessions.getState().sessions[EPIC] as any).agentSnapshotId).toBe('new')
  })

  it('toasts the error message on failure', async () => {
    refreshAgentSnapshot.mockResolvedValue({ ok: false, code: 'not_found', message: 'Epic epic-1 is gone.' })
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} epicId={EPIC} />)
    await act(async () => { btn(el)!.click() })
    expect(refreshAgentSnapshot).toHaveBeenCalledWith({ cwd: CWD, epicId: EPIC })
    expect(showSpy).toHaveBeenCalledWith('error', 'Epic epic-1 is gone.')
    expect((usePromptSessions.getState().sessions[EPIC] as any).agentSnapshotId).toBe('old')
  })

  it('toasts a thrown IPC error', async () => {
    refreshAgentSnapshot.mockRejectedValue(new Error('ipc exploded'))
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} epicId={EPIC} />)
    await act(async () => { btn(el)!.click() })
    expect(showSpy).toHaveBeenCalledWith('error', 'ipc exploded')
  })
})
