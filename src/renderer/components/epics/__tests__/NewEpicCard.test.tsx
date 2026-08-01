// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { NewEpicCard } from '../NewEpicCard'
import { usePromptSessions } from '../../../state/promptSessions'
import { useSessions } from '../../../state/sessions'
import { useChat } from '../../../state/chat'

const createPromptSessionSpy = vi.fn(usePromptSessions.getState().createPromptSession)
const sendSpy = vi.fn()

vi.mock('../../../lib/useKnownProjects', () => ({
  useKnownProjects: () => ({
    rows: [
      { encoded: '-home-bilko-Projects-alpha', displayPath: '', sessionCount: 0, lastSession: 0, path: '', sizeBytes: 0 },
      { encoded: '-home-bilko-Projects-beta', displayPath: '', sessionCount: 0, lastSession: 0, path: '', sizeBytes: 0 },
    ],
    enriched: {
      '-home-bilko-Projects-alpha': { cwd: '/home/bilko/Projects/alpha' },
      '-home-bilko-Projects-beta': { cwd: '/home/bilko/Projects/beta' },
    },
    loading: false,
  }),
  candidatePath: (encoded: string) => encoded.replace(/-/g, '/'),
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  usePromptSessions.setState({ sessions: {}, events: {} })
  usePromptSessions.setState({ createPromptSession: createPromptSessionSpy })
  createPromptSessionSpy.mockClear()
  useChat.setState({ send: sendSpy })
  sendSpy.mockClear()
  useSessions.setState({ tabs: [], activeTabId: null })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('NewEpicCard', () => {
  it('disables Create until a project and a goal are present', () => {
    const el = mount(<NewEpicCard onCreated={vi.fn()} onCancel={vi.fn()} />)
    const create = el.querySelector('[data-testid="new-epic-create"]') as HTMLButtonElement
    expect(create.disabled).toBe(true)

    const goal = el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement
    act(() => setNativeValue(goal, 'Ship the thing'))
    expect(create.disabled).toBe(false)
  })

  it('calls createPromptSession(cwd, goal, tag) and fires onCreated with the new id on goal-only submission', async () => {
    const onCreated = vi.fn()
    const el = mount(<NewEpicCard onCreated={onCreated} onCancel={vi.fn()} />)

    const cwdSelect = el.querySelector('[data-testid="new-prompt-cwd"]') as HTMLSelectElement
    act(() => {
      cwdSelect.value = '/home/bilko/Projects/beta'
      cwdSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const goal = el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement
    act(() => setNativeValue(goal, 'Fix the flaky test'))

    const create = el.querySelector('[data-testid="new-epic-create"]') as HTMLButtonElement
    act(() => create.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // handleCreate awaits attachment resolution (PRD 865) — flush it.
    await act(async () => {})

    expect(createPromptSessionSpy).toHaveBeenCalledWith('/home/bilko/Projects/beta', 'Fix the flaky test', 'feature', 'proposed')
    const created = Object.values(usePromptSessions.getState().sessions)[0]
    expect(onCreated).toHaveBeenCalledWith(created.id)
  })

  it('folds a typed title in as a leading line and respects the selected kind pill', async () => {
    const onCreated = vi.fn()
    const el = mount(<NewEpicCard onCreated={onCreated} onCancel={vi.fn()} />)

    const title = el.querySelector('[data-testid="new-epic-title"]') as HTMLInputElement
    act(() => setNativeValue(title, 'Flaky test'))
    const goal = el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement
    act(() => setNativeValue(goal, 'Make CI stop flaking'))
    const bugPill = el.querySelector('[data-testid="new-epic-kind-bug"]') as HTMLButtonElement
    act(() => bugPill.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const create = el.querySelector('[data-testid="new-epic-create"]') as HTMLButtonElement
    act(() => create.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // handleCreate awaits attachment resolution (PRD 865) — flush it.
    await act(async () => {})

    expect(createPromptSessionSpy).toHaveBeenCalledWith(
      '/home/bilko/Projects/alpha',
      'Flaky test\n\nMake CI stop flaking',
      'bug',
      'proposed',
    )
  })

  it('folds attached reference paths into goalText as trailing "Reference:" lines', async () => {
    const onCreated = vi.fn()
    const el = mount(<NewEpicCard onCreated={onCreated} onCancel={vi.fn()} />)

    const goal = el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement
    act(() => setNativeValue(goal, 'Investigate the crash'))

    const fileInput = el.querySelector('[data-testid="new-epic-attach-tray"] input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'crash.log', { type: 'text/plain' })
    Object.defineProperty(file, 'path', { value: '/home/bilko/Downloads/crash.log' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    act(() => fileInput.dispatchEvent(new Event('change', { bubbles: true })))

    const create = el.querySelector('[data-testid="new-epic-create"]') as HTMLButtonElement
    act(() => create.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // handleCreate awaits attachment resolution (PRD 865) — flush it.
    await act(async () => {})

    expect(createPromptSessionSpy).toHaveBeenCalledWith(
      '/home/bilko/Projects/alpha',
      'Investigate the crash\n\nReference: /home/bilko/Downloads/crash.log',
      'feature',
      'proposed',
    )
  })

  it('resets form state after a successful create and on Cancel', async () => {
    const onCreated = vi.fn()
    const onCancel = vi.fn()
    const el = mount(<NewEpicCard onCreated={onCreated} onCancel={onCancel} />)

    const goal = el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement
    act(() => setNativeValue(goal, 'Ship it'))
    const create = el.querySelector('[data-testid="new-epic-create"]') as HTMLButtonElement
    act(() => create.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // handleCreate awaits attachment resolution (PRD 865) — flush it.
    await act(async () => {})
    expect((el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement).value).toBe('')

    act(() => setNativeValue(el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement, 'another goal'))
    const cancel = el.querySelector('[data-testid="new-epic-cancel"]') as HTMLButtonElement
    act(() => cancel.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onCancel).toHaveBeenCalled()
    expect((el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement).value).toBe('')
  })

  it('auto-sends the title + objective as the Epic\'s first prompt, so it opens waiting on the agent', async () => {
    const el = mount(<NewEpicCard onCreated={vi.fn()} onCancel={vi.fn()} />)

    const title = el.querySelector('[data-testid="new-epic-title"]') as HTMLInputElement
    act(() => setNativeValue(title, 'Flaky test'))
    const goal = el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement
    act(() => setNativeValue(goal, 'Make CI stop flaking'))

    const create = el.querySelector('[data-testid="new-epic-create"]') as HTMLButtonElement
    act(() => create.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // handleCreate awaits attachment resolution (PRD 865) — flush it.
    await act(async () => {})

    const created = Object.values(usePromptSessions.getState().sessions)[0]
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy).toHaveBeenCalledWith({
      tabId: created.id,
      sessionId: created.claudeSessionId,
      cwd: '/home/bilko/Projects/alpha',
      prompt: 'Goal: Flaky test\n\nMake CI stop flaking',
    })
  })

  it('sends into the Epic\'s own claude session, never a SessionTab id', async () => {
    const el = mount(<NewEpicCard onCreated={vi.fn()} onCancel={vi.fn()} />)
    const goal = el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement
    act(() => setNativeValue(goal, 'Just the objective'))
    const create = el.querySelector('[data-testid="new-epic-create"]') as HTMLButtonElement
    act(() => create.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // handleCreate awaits attachment resolution (PRD 865) — flush it.
    await act(async () => {})

    const created = Object.values(usePromptSessions.getState().sessions)[0]
    const args = sendSpy.mock.calls[0][0]
    expect(args.sessionId).toBe(created.claudeSessionId)
    expect(args.sessionId).not.toBe(created.id)
    expect(args.prompt).toBe('Just the objective')
  })
})
