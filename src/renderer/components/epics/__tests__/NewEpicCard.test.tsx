// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { NewEpicCard } from '../NewEpicCard'
import { usePromptSessions } from '../../../state/promptSessions'
import { useSessions } from '../../../state/sessions'
import { useChat } from '../../../state/chat'
import { agentTagDef } from '../../../lib/agentTagDefs'
import { CONTEXT_INJECTIONS } from '../../../lib/contextInjections'
import type { AgentPersona } from '../../../../preload/api'
import { fakePromptSessionsCreate } from '../../../testUtils/fakePromptSessionsCreate'

const createPromptSessionSpy = vi.fn(usePromptSessions.getState().createPromptSession)
const sendSpy = vi.fn()
const listPersonasSpy = vi.fn(async (): Promise<AgentPersona[]> => [])

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
  listPersonasSpy.mockClear()
  listPersonasSpy.mockResolvedValue([])
  ;(window as unknown as { api: unknown }).api = {
    agents: { listPersonas: listPersonasSpy },
    app: { homeDir: vi.fn().mockResolvedValue('/home/bilko'), gitBranch: vi.fn().mockResolvedValue('main') },
    config: {
      readText: vi.fn().mockResolvedValue({ exists: false, text: '', mtimeMs: 0, error: null }),
      readJson: vi.fn().mockResolvedValue({ exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: null }),
      listDir: vi.fn().mockResolvedValue({ ok: true, entries: [], error: null }),
      exists: vi.fn().mockResolvedValue(false),
    },
    promptSessions: { create: fakePromptSessionsCreate(), onEventAppended: vi.fn() },
  }
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

    // Sliced to the first 4 args (cwd/goalText/tag/source) — openingPrompt/
    // sections (trailing args, PRD session-chat-conversion-into-simplified-chat)
    // are covered by their own dedicated tests below, not re-asserted here.
    expect(createPromptSessionSpy.mock.calls[0].slice(0, 4)).toEqual(['/home/bilko/Projects/beta', 'Fix the flaky test', 'feature', 'NewEpicCard'])
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

    expect(createPromptSessionSpy.mock.calls[0].slice(0, 4)).toEqual([
      '/home/bilko/Projects/alpha',
      'Flaky test\n\nMake CI stop flaking',
      'bug',
      'NewEpicCard',
    ])
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

    expect(createPromptSessionSpy.mock.calls[0].slice(0, 4)).toEqual([
      '/home/bilko/Projects/alpha',
      'Investigate the crash\n\nReference: /home/bilko/Downloads/crash.log',
      'feature',
      'NewEpicCard',
    ])
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
      prompt:
        `${CONTEXT_INJECTIONS['general-behavior'].text}\n\n` +
        'You are building new functionality. Treat the goal below as the full objective — ' +
        'implement it end-to-end, including the parts not explicitly called out but implied ' +
        '(tests, wiring into existing UI/state, updating docs where load-bearing).\n\n' +
        'Goal: Flaky test\n\nMake CI stop flaking',
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
    expect(args.prompt.endsWith('Just the objective')).toBe(true)
  })

  it('loads the Agent Library as a button list under "1 · agent", with no "Default" pseudo-agent', async () => {
    listPersonasSpy.mockResolvedValue([
      { name: 'builder', description: 'Ships releases.', tools: [], model: null, color: null, tags: [], path: '', body: '', overridingProjects: [] },
      { name: 'debugger', description: 'Diagnoses failures.', tools: [], model: null, color: null, tags: [], path: '', body: '', overridingProjects: [] },
    ])
    const el = mount(<NewEpicCard onCreated={vi.fn()} onCancel={vi.fn()} />)
    await act(async () => {})

    expect(el.querySelector('[data-testid="new-epic-agent-default"]')).toBeNull()
    expect(el.textContent).not.toContain('Default')
    // No 'architect' in this library, so the first persona is pinned instead —
    // the "who is working" slot always names a real agent.
    const builder = el.querySelector('[data-testid="new-epic-agent-builder"]') as HTMLButtonElement
    expect(builder.getAttribute('data-selected')).toBe('true')
    expect(el.querySelector('[data-testid="new-epic-agent-debugger"]')).not.toBeNull()
  })

  it('pre-selects the "architect" persona by default when one exists in the Agent Library', async () => {
    listPersonasSpy.mockResolvedValue([
      { name: 'architect', description: 'Owns overall plan and decomposition.', tools: [], model: 'opus', color: null, tags: [], path: '', body: '', overridingProjects: [] },
      { name: 'builder', description: 'Ships releases.', tools: [], model: null, color: null, tags: [], path: '', body: '', overridingProjects: [] },
    ])
    const el = mount(<NewEpicCard onCreated={vi.fn()} onCancel={vi.fn()} />)
    await act(async () => {})

    // Pinned as the one "who is working" — position is the signal, no accent ring.
    const architectBtn = el.querySelector('[data-testid="new-epic-agent-architect"]') as HTMLButtonElement
    expect(architectBtn.getAttribute('data-selected')).toBe('true')
    expect(architectBtn.className).not.toContain('border-accent')
    expect(el.querySelector('[data-testid="new-epic-agent-default"]')).toBeNull()
    // ...and it is not also repeated in the "available agents by role" list.
    expect(el.querySelectorAll('[data-testid="new-epic-agent-architect"]').length).toBe(1)
    expect((el.querySelector('[data-testid="new-epic-agent-builder"]') as HTMLButtonElement)
      .getAttribute('data-selected')).toBe('false')

    const goal = el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement
    act(() => setNativeValue(goal, 'Plan the next phase'))
    const create = el.querySelector('[data-testid="new-epic-create"]') as HTMLButtonElement
    act(() => create.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => {})

    expect(createPromptSessionSpy.mock.calls[0].slice(0, 5)).toEqual([
      '/home/bilko/Projects/alpha',
      'Plan the next phase',
      'feature',
      'NewEpicCard',
      'architect',
    ])
  })

  it('threads the selected agent into createPromptSession and grounds the opening prompt with its description', async () => {
    listPersonasSpy.mockResolvedValue([
      { name: 'builder', description: 'Ships releases end to end.', tools: [], model: null, color: null, tags: [], path: '', body: '', overridingProjects: [] },
    ])
    const el = mount(<NewEpicCard onCreated={vi.fn()} onCancel={vi.fn()} />)
    await act(async () => {})

    const goal = el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement
    act(() => setNativeValue(goal, 'Cut the next release'))

    const builderBtn = el.querySelector('[data-testid="new-epic-agent-builder"]') as HTMLButtonElement
    act(() => builderBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const create = el.querySelector('[data-testid="new-epic-create"]') as HTMLButtonElement
    act(() => create.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => {})

    expect(createPromptSessionSpy.mock.calls[0].slice(0, 5)).toEqual([
      '/home/bilko/Projects/alpha',
      'Cut the next release',
      'feature',
      'NewEpicCard',
      'builder',
    ])
    const args = sendSpy.mock.calls[0][0]
    expect(args.prompt.startsWith('You are acting as the "builder" agent: Ships releases end to end.')).toBe(true)

    // INTERACTION EFFECT (session-chat-conversion-into-simplified-chat): the
    // opening prompt sent into chat (args.prompt) and the openingPrompt/
    // sections persisted on the Epic via createPromptSession's 6th/7th args
    // must be the exact same composeEpicIntake output, computed once — never
    // a second, independently re-derived copy.
    const [, , , , , persistedOpeningPrompt, persistedSections] = createPromptSessionSpy.mock.calls[0]
    expect(persistedOpeningPrompt).toBe(args.prompt)
    expect(Array.isArray(persistedSections)).toBe(true)
    const sections = persistedSections as Array<{ kind: string; source?: string }>
    expect(sections[0]).toMatchObject({ kind: 'actor', source: 'builder' })
    expect(sections.some((s) => s.kind === 'goal')).toBe(true)
  })

  it('leaves the agentType arg undefined and the prompt un-grounded (no actor section) when the Agent Library is empty', async () => {
    const el = mount(<NewEpicCard onCreated={vi.fn()} onCancel={vi.fn()} />)
    await act(async () => {})
    const goal = el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement
    act(() => setNativeValue(goal, 'Ship it'))
    const create = el.querySelector('[data-testid="new-epic-create"]') as HTMLButtonElement
    act(() => create.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => {})

    expect(createPromptSessionSpy.mock.calls[0].slice(0, 4)).toEqual(['/home/bilko/Projects/alpha', 'Ship it', 'feature', 'NewEpicCard'])
    const [, , , , agentType, , sections] = createPromptSessionSpy.mock.calls[0]
    expect(agentType).toBeUndefined()
    expect((sections as Array<{ kind: string }>).some((s) => s.kind === 'actor')).toBe(false)
  })

  it('derives the Mission pills from the selected persona\'s own tags, and re-derives them when the agent changes', async () => {
    listPersonasSpy.mockResolvedValue([
      { name: 'architect', description: 'Plans.', tools: [], model: 'opus', color: null, tags: ['feature', 'bug', 'discussion'], path: '', body: '', overridingProjects: [] },
      { name: 'builder', description: 'Ships releases.', tools: [], model: null, color: null, tags: ['build'], path: '', body: '', overridingProjects: [] },
      { name: 'project-home-builder', description: 'Generates pages.', tools: [], model: null, color: null, tags: ['project-home-builder'], path: '', body: '', overridingProjects: [] },
    ])
    const el = mount(<NewEpicCard onCreated={vi.fn()} onCancel={vi.fn()} />)
    await act(async () => {})

    expect(el.querySelector('[data-testid="new-epic-kind-feature"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="new-epic-kind-build"]')).toBeNull()

    const builderBtn = el.querySelector('[data-testid="new-epic-agent-builder"]') as HTMLButtonElement
    await act(async () => { builderBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(el.querySelector('[data-testid="new-epic-kind-build"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="new-epic-kind-feature"]')).toBeNull()
    // The invalidated 'feature' pick snaps to the new agent's only mission.
    expect(el.textContent).toContain(agentTagDef('build').description)

    const phb = el.querySelector('[data-testid="new-epic-agent-project-home-builder"]') as HTMLButtonElement
    await act(async () => { phb.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(el.querySelector('[data-testid="new-epic-kind-project-home-builder"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="new-epic-kind-build"]')).toBeNull()
  })

  it('sends the tag from the selected agent\'s own tags into createPromptSession', async () => {
    listPersonasSpy.mockResolvedValue([
      { name: 'builder', description: 'Ships releases.', tools: [], model: null, color: null, tags: ['build'], path: '', body: '', overridingProjects: [] },
    ])
    const el = mount(<NewEpicCard onCreated={vi.fn()} onCancel={vi.fn()} />)
    await act(async () => {})

    const goal = el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement
    act(() => setNativeValue(goal, 'Cut v1'))
    const create = el.querySelector('[data-testid="new-epic-create"]') as HTMLButtonElement
    act(() => create.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => {})

    expect(createPromptSessionSpy.mock.calls[0].slice(0, 5)).toEqual([
      '/home/bilko/Projects/alpha', 'Cut v1', 'build', 'NewEpicCard', 'builder',
    ])
  })

  it('shows the Mission blurb from the single global agentTagDef source, never a local copy', async () => {
    const el = mount(<NewEpicCard onCreated={vi.fn()} onCancel={vi.fn()} />)
    await act(async () => {})

    expect(el.textContent).toContain(agentTagDef('feature').description)

    const bugPill = el.querySelector('[data-testid="new-epic-kind-bug"]') as HTMLButtonElement
    act(() => bugPill.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(el.textContent).toContain(agentTagDef('bug').description)

    const discussionPill = el.querySelector('[data-testid="new-epic-kind-discussion"]') as HTMLButtonElement
    act(() => discussionPill.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(el.textContent).toContain(agentTagDef('discussion').description)
  })

  it('flips to the grounding board on "advanced" and back, without losing form state', async () => {
    const el = mount(<NewEpicCard onCreated={vi.fn()} onCancel={vi.fn()} />)
    await act(async () => {})
    const goal = el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement
    act(() => setNativeValue(goal, 'Investigate the leak'))

    const toggle = el.querySelector('[data-testid="new-epic-advanced-toggle"]') as HTMLButtonElement
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => {})
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(el.querySelector('[data-testid="grounding-group-system"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="grounding-group-project"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="grounding-group-local"]')).not.toBeNull()

    const back = el.querySelector('[data-testid="new-epic-flip-to-goal"]') as HTMLButtonElement
    act(() => back.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect((el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement).value).toBe('Investigate the leak')
  })

  it('INTERACTION EFFECT: populates sections on the board-already-computed path (advanced opened before submit), same as the fresh-computed path', async () => {
    // CLAUDE.md requires exactly one grounding-board fetch path — this proves
    // the cached `board` (from opening "advanced") is what composeEpicIntake
    // reads, not a second independent computeGroundingBoard call at submit.
    const el = mount(<NewEpicCard onCreated={vi.fn()} onCancel={vi.fn()} />)
    await act(async () => {})
    const goal = el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement
    act(() => setNativeValue(goal, 'Investigate the leak'))

    const toggle = el.querySelector('[data-testid="new-epic-advanced-toggle"]') as HTMLButtonElement
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => {})
    const readTextCallsBeforeSubmit = (window.api.config.readText as ReturnType<typeof vi.fn>).mock.calls.length

    const back = el.querySelector('[data-testid="new-epic-flip-to-goal"]') as HTMLButtonElement
    act(() => back.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const create = el.querySelector('[data-testid="new-epic-create"]') as HTMLButtonElement
    act(() => create.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => {})

    // No second fs/IPC read fired at submit — the cached board was reused.
    expect((window.api.config.readText as ReturnType<typeof vi.fn>).mock.calls.length).toBe(readTextCallsBeforeSubmit)

    const [, , , , , persistedOpeningPrompt, persistedSections] = createPromptSessionSpy.mock.calls[0]
    const inputSection = (persistedSections as Array<{ kind: string; text: string }>).find((s) => s.kind === 'input')
    expect(inputSection).toBeTruthy()
    expect(persistedOpeningPrompt).toContain(inputSection!.text)
  })

  it('truncates a long real persona description instead of forcing the row to overflow', async () => {
    // Regression for a real bug: a flex row's children default to
    // min-width:auto, so `truncate` on the description span silently did
    // nothing until the row (and the whole two-column grid) was given
    // min-w-0 all the way down — with the short mock personas used
    // elsewhere in this file that never showed up, but a real persona like
    // project-home-builder's full-sentence description blew the layout out
    // sideways in the actual app.
    listPersonasSpy.mockResolvedValue([
      {
        name: 'project-home-builder',
        description:
          "Generates a project's static Project Home/Project Pages from that project's own saved component library and a computed project summary, if that pipeline exists in this repo yet.",
        tools: [],
        model: null,
        color: null,
        tags: [],
        path: '',
        body: '',
        overridingProjects: [],
      },
    ])
    const el = mount(<NewEpicCard onCreated={vi.fn()} onCancel={vi.fn()} />)
    await act(async () => {})

    const row = el.querySelector('[data-testid="new-epic-agent-project-home-builder"]') as HTMLButtonElement
    expect(row.className).toContain('min-w-0')
    const descriptionSpan = Array.from(row.querySelectorAll('span')).find((s) => s.textContent?.includes('Generates a project'))
    expect(descriptionSpan).toBeTruthy()
    expect(descriptionSpan!.className).toContain('truncate')
    expect(descriptionSpan!.className).toContain('min-w-0')
  })
})
