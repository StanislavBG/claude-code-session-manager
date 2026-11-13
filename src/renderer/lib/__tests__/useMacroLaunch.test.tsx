// @vitest-environment jsdom
/**
 * useMacroLaunch — shared mint -> approve -> send path for pressing a Macro.
 * Default behaviour must stay byte-for-byte what SessionActionsBar always
 * did; job macros add a readiness gate + strict persona check.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useMacroLaunch } from '../useMacroLaunch'
import { usePromptSessions } from '../../state/promptSessions'
import { useSessions } from '../../state/sessions'
import { useChat } from '../../state/chat'
import { useToast } from '../../state/toast'
import { useMacroCostPrompt, type MacroCostChoice } from '../../state/macroCostPrompt'
import { fakePromptSessionsCreate } from '../../testUtils/fakePromptSessionsCreate'
import type { AgentPersona, Macro } from '../../../preload/api'

const CWD = '/home/bilko/Projects/alpha'

function persona(over: Partial<AgentPersona> = {}): AgentPersona {
  return {
    name: 'scout', description: 'Looks around.', tools: [], model: null, effort: null, color: null,
    tags: [], projects: [], action: null, actionLabel: null, path: '', body: '', overridingProjects: [], ...over,
  }
}
function macro(over: Partial<Macro> = {}): Macro {
  return {
    id: 'm1', label: 'Sweep', agentName: 'scout', tag: 'bug', prompt: 'Sweep it.\nSecond line', projects: [CWD],
    surface: 'sessions', createdAt: '', updatedAt: '', ...over,
  }
}

const createPromptSessionSpy = vi.fn(usePromptSessions.getState().createPromptSession)
const approveProposedSpy = vi.fn()
const sendSpy = vi.fn()
const JOB = { estimateMinutes: 10, artifactPaths: [] }
const READY = { ok: true, checks: [] }

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(el) })
  return container
}

function Harness({ personas, onSelect, extraInstructions, macroOver, inputValues }: {
  personas: AgentPersona[]
  onSelect: (id: string) => void
  extraInstructions?: string
  macroOver?: Partial<Macro>
  inputValues?: Record<string, string>
}) {
  const { launch, launching } = useMacroLaunch(onSelect, personas)
  return (
    <button
      type="button"
      disabled={launching !== null}
      onClick={() => void launch(macro(macroOver), extraInstructions, inputValues)}
    >
      Launch
    </button>
  )
}

beforeEach(() => {
  usePromptSessions.setState({ sessions: {}, events: {} })
  usePromptSessions.setState({ createPromptSession: createPromptSessionSpy, approveProposed: approveProposedSpy })
  createPromptSessionSpy.mockClear()
  approveProposedSpy.mockClear()
  sendSpy.mockClear()
  useChat.setState({ send: sendSpy })
  useSessions.setState({ tabs: [{ id: 'tab-1', cwd: CWD } as any], activeTabId: 'tab-1' })
  ;(globalThis as any).window.api = {
    promptSessions: { create: fakePromptSessionsCreate(), onEventAppended: vi.fn() },
    app: { delegationReadiness: vi.fn().mockResolvedValue(READY) },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
})

describe('useMacroLaunch', () => {
  it('default path: mints, approves, sends and selects', async () => {
    const onSelect = vi.fn()
    const el = await mount(<Harness personas={[persona()]} onSelect={onSelect} />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    const [cwd, , tag, , agentType, openingPrompt] = createPromptSessionSpy.mock.calls[0]
    expect(cwd).toBe(CWD)
    expect(tag).toBe('bug')
    expect(agentType).toBe('scout')
    expect(openingPrompt).toContain('Sweep it.')
    const created = Object.values(usePromptSessions.getState().sessions)[0]
    expect(approveProposedSpy).toHaveBeenCalledWith(created.id, 'SessionActionsBar scout')
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ tabId: created.id, cwd: CWD }))
    expect(onSelect).toHaveBeenCalledWith(created.id)
    expect(createPromptSessionSpy.mock.calls[0][7]).toEqual({ macroId: 'm1' })
    expect((globalThis as any).window.api.promptSessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ source: { producer: 'new-epic-ui', macroId: 'm1' } }),
    )
  })

  it('extraInstructions omitted or blank: goal is unchanged', async () => {
    const onSelect = vi.fn()
    const el = await mount(<Harness personas={[persona()]} onSelect={onSelect} extraInstructions="   " />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    const [, goalText] = createPromptSessionSpy.mock.calls[0]
    expect(goalText).toBe('Sweep\n\nSweep it.\nSecond line')
  })

  it('extraInstructions provided: appended as an Additional instructions paragraph', async () => {
    const onSelect = vi.fn()
    const el = await mount(
      <Harness personas={[persona()]} onSelect={onSelect} extraInstructions="  focus on the auth flow  " />,
    )
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    const [, goalText, , , , openingPrompt] = createPromptSessionSpy.mock.calls[0]
    expect(goalText).toBe('Sweep\n\nSweep it.\nSecond line\n\nAdditional instructions: focus on the auth flow')
    expect(openingPrompt).toContain('Additional instructions: focus on the auth flow')
  })

  it('a job-less macro mints a new Epic even when an active Epic with the same agent and tag exists', async () => {
    usePromptSessions.setState({
      sessions: {
        existing: {
          id: 'existing', cwd: CWD, goalText: 'Sweep', claudeSessionId: 'sess-1', status: 'active',
          createdAt: '2026-08-02T00:00:00.000Z', completedAt: null, tag: 'bug', agentType: 'scout',
        } as any,
      },
    })
    const onSelect = vi.fn()
    const el = await mount(
      <Harness
        personas={[persona()]}
        onSelect={onSelect}
        macroOver={{ prompt: 'run stream={{stream}}', inputs: [{ name: 'stream', label: 'Stream', default: 'x' }] } as Partial<Macro>}
        inputValues={{ stream: 'math' }}
      />,
    )
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    const [, goalText, tag, , agentType] = createPromptSessionSpy.mock.calls[0]
    expect(goalText).toBe('Sweep\n\nrun stream=math')
    expect(tag).toBe('bug')
    expect(agentType).toBe('scout')
    expect(createPromptSessionSpy.mock.calls[0][7]).toEqual({ macroId: 'm1' })
    const created = Object.values(usePromptSessions.getState().sessions).find((s) => s.id !== 'existing')!
    expect(onSelect).toHaveBeenCalledWith(created.id)
    expect(onSelect).not.toHaveBeenCalledWith('existing')
  })

  it('a job-less macro never calls delegationReadiness', async () => {
    const el = await mount(<Harness personas={[persona()]} onSelect={vi.fn()} />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    expect((globalThis as any).window.api.app.delegationReadiness).not.toHaveBeenCalled()
    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
  })

  it('a completed Epic for the same (cwd, agentName, tag) still mints a new one', async () => {
    usePromptSessions.setState({
      sessions: {
        done: {
          id: 'done',
          cwd: CWD,
          goalText: 'Sweep',
          claudeSessionId: 'sess-1',
          status: 'completed',
          createdAt: '2026-08-02T00:00:00.000Z',
          completedAt: '2026-08-03T00:00:00.000Z',
          tag: 'bug',
          agentType: 'scout',
        } as any,
      },
    })
    const onSelect = vi.fn()
    const el = await mount(<Harness personas={[persona()]} onSelect={onSelect} />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    const created = Object.values(usePromptSessions.getState().sessions).find((s) => s.id !== 'done')!
    expect(onSelect).toHaveBeenCalledWith(created.id)
  })

  it('job macro: delegationReadiness ok:false blocks the mint and toasts the failing checks', async () => {
    ;(globalThis as any).window.api.app.delegationReadiness = vi.fn().mockResolvedValue({
      ok: false,
      checks: [{ id: 'x', label: 'Scheduler MCP server answers tools/list', ok: false, detail: 'timeout', fix: null }],
    })
    const onSelect = vi.fn()
    const el = await mount(<Harness personas={[persona()]} onSelect={onSelect} macroOver={{ job: JOB }} />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    expect(
      useToast.getState().toasts.some((t) => t.kind === 'error' && t.message.includes('Scheduler MCP server answers tools/list')),
    ).toBe(true)
  })

  it('job macro: delegationReadiness throwing blocks the mint and toasts', async () => {
    ;(globalThis as any).window.api.app.delegationReadiness = vi.fn().mockRejectedValue(new Error('timeout'))
    const onSelect = vi.fn()
    const el = await mount(<Harness personas={[persona()]} onSelect={onSelect} macroOver={{ job: JOB }} />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(useToast.getState().toasts.some((t) => t.kind === 'error' && t.message.includes('timeout'))).toBe(true)
  })

  it('job macro: a missing persona blocks even while the personas list is still empty', async () => {
    const onSelect = vi.fn()
    const el = await mount(<Harness personas={[]} onSelect={onSelect} macroOver={{ job: JOB }} />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
    expect(
      useToast.getState().toasts.some((t) => t.kind === 'error' && t.message.includes('scout')),
    ).toBe(true)
  })

  describe('macro inputs', () => {
    const withInputs = {
      prompt: 'run stream={{stream}}',
      inputs: [{ name: 'stream', label: 'Stream', default: 'education-veggies' }],
    } as Partial<Macro>

    it('no values passed: placeholders render with the input defaults', async () => {
      const el = await mount(<Harness personas={[persona()]} onSelect={vi.fn()} macroOver={withInputs} />)
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

      const [, goalText] = createPromptSessionSpy.mock.calls[0]
      expect(goalText).toBe('Sweep\n\nrun stream=education-veggies')
    })

    it('values passed: the override replaces the default', async () => {
      const el = await mount(
        <Harness personas={[persona()]} onSelect={vi.fn()} macroOver={withInputs} inputValues={{ stream: 'math' }} />,
      )
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

      const [, goalText] = createPromptSessionSpy.mock.calls[0]
      expect(goalText).toBe('Sweep\n\nrun stream=math')
    })

    it('a required input left empty toasts and mints nothing', async () => {
      const onSelect = vi.fn()
      const el = await mount(
        <Harness
          personas={[persona()]}
          onSelect={onSelect}
          macroOver={{
            prompt: 'run stream={{stream}}',
            inputs: [{ name: 'stream', label: 'Stream', required: true }],
          } as Partial<Macro>}
          inputValues={{ stream: '' }}
        />,
      )
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

      expect(createPromptSessionSpy).not.toHaveBeenCalled()
      expect(sendSpy).not.toHaveBeenCalled()
      expect(onSelect).not.toHaveBeenCalled()
      expect(
        useToast.getState().toasts.some(
          (t) => t.kind === 'error' && t.message === 'Cannot start "Sweep" — "Stream" is required',
        ),
      ).toBe(true)
    })

    it('a macro without inputs sends a goal identical to its prompt', async () => {
      const el = await mount(
        <Harness personas={[persona()]} onSelect={vi.fn()} macroOver={{ prompt: 'keep $& literal' }} />,
      )
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

      const [, goalText] = createPromptSessionSpy.mock.calls[0]
      expect(goalText).toBe('Sweep\n\nkeep $& literal')
    })

    it('a macro without inputs but with a placeholder toasts and mints nothing', async () => {
      const el = await mount(
        <Harness personas={[persona()]} onSelect={vi.fn()} macroOver={{ prompt: 'keep {{this}} literal' }} />,
      )
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

      expect(createPromptSessionSpy).not.toHaveBeenCalled()
      expect(
        useToast.getState().toasts.some(
          (t) => t.kind === 'error' && t.message === 'Cannot start "Sweep" — prompt uses undeclared input {{this}}',
        ),
      ).toBe(true)
    })
  })

  describe('cost prompt', () => {
    const dispatchJob = vi.fn()
    let confirmSpy: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      confirmSpy = vi.spyOn(window, 'confirm')
      useMacroCostPrompt.setState({ hostMounted: true, request: null })
      dispatchJob.mockReset()
      dispatchJob.mockResolvedValue({ ok: true, slug: 's', epicId: 'e' })
      ;(globalThis as any).window.api.macros = { dispatchJob }
      ;(globalThis as any).window.api.agents = { getPersonaBody: vi.fn().mockResolvedValue(null) }
    })
    afterEach(() => {
      confirmSpy.mockRestore()
      useMacroCostPrompt.setState({ hostMounted: false, request: null })
    })

    /** Press the button, wait for the prompt to open, then answer it. */
    async function pressAndAnswer(el: HTMLElement, choice: MacroCostChoice) {
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })
      const req = useMacroCostPrompt.getState().request
      expect(req).not.toBeNull()
      await act(async () => { useMacroCostPrompt.getState().answer(choice) })
      return req!
    }

    it('cancel: nothing is minted or readiness-checked', async () => {
      const onSelect = vi.fn()
      const el = await mount(
        <Harness personas={[persona({ effort: 'max' })]} onSelect={onSelect} macroOver={{ job: JOB }} />,
      )
      const req = await pressAndAnswer(el, { proceed: false })

      expect(req).toMatchObject({ cwd: CWD, macroLabel: 'Sweep', agentName: 'scout', effort: 'max' })
      expect(confirmSpy).not.toHaveBeenCalled()
      expect(createPromptSessionSpy).not.toHaveBeenCalled()
      expect(sendSpy).not.toHaveBeenCalled()
      expect(onSelect).not.toHaveBeenCalled()
      expect(dispatchJob).not.toHaveBeenCalled()
      expect((globalThis as any).window.api.app.delegationReadiness).not.toHaveBeenCalled()
    })

    it('run as-is: launches exactly once with no effort in the runtime argument', async () => {
      const onSelect = vi.fn()
      const el = await mount(<Harness personas={[persona({ effort: 'max' })]} onSelect={onSelect} />)
      await pressAndAnswer(el, { proceed: true, effort: null })

      expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
      expect(createPromptSessionSpy.mock.calls[0][7]).toEqual({ macroId: 'm1' })
      expect(onSelect).toHaveBeenCalledTimes(1)
    })

    it("run lower 'medium': mints with runtime effort 'medium'", async () => {
      const onSelect = vi.fn()
      const el = await mount(<Harness personas={[persona({ effort: 'max' })]} onSelect={onSelect} />)
      await pressAndAnswer(el, { proceed: true, effort: 'medium' })

      expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
      expect(createPromptSessionSpy.mock.calls[0][7]).toEqual({ macroId: 'm1', effort: 'medium' })
      expect(onSelect).toHaveBeenCalledTimes(1)
    })

    it("job macro, new Epic: dispatchJob gets effort 'medium'", async () => {
      const el = await mount(
        <Harness personas={[persona({ effort: 'max' })]} onSelect={vi.fn()} macroOver={{ job: JOB }} />,
      )
      await pressAndAnswer(el, { proceed: true, effort: 'medium' })

      expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
      expect(createPromptSessionSpy.mock.calls[0][7]).toEqual({ macroId: 'm1', effort: 'medium' })
      expect(dispatchJob).toHaveBeenCalledTimes(1)
      expect(dispatchJob.mock.calls[0][0]).toMatchObject({ macroId: 'm1', effort: 'medium' })
    })

    it("job macro, reuse active Epic: dispatchJob gets effort 'medium'", async () => {
      usePromptSessions.setState({
        sessions: { act1: { id: 'act1', cwd: CWD, tag: 'bug', agentType: 'scout', status: 'active' } as any },
      })
      const el = await mount(
        <Harness personas={[persona({ effort: 'max' })]} onSelect={vi.fn()} macroOver={{ job: JOB }} />,
      )
      await pressAndAnswer(el, { proceed: true, effort: 'medium' })

      expect(createPromptSessionSpy).not.toHaveBeenCalled()
      expect(dispatchJob).toHaveBeenCalledWith({
        cwd: CWD, macroId: 'm1', epicId: 'act1', extraInstructions: undefined, effort: 'medium',
      })
    })

    it('job macro, reuse active Epic, run as-is: payload has no effort key', async () => {
      usePromptSessions.setState({
        sessions: { act1: { id: 'act1', cwd: CWD, tag: 'bug', agentType: 'scout', status: 'active' } as any },
      })
      const el = await mount(
        <Harness personas={[persona({ effort: 'max' })]} onSelect={vi.fn()} macroOver={{ job: JOB }} />,
      )
      await pressAndAnswer(el, { proceed: true, effort: null })

      expect(dispatchJob).toHaveBeenCalledTimes(1)
      expect(dispatchJob.mock.calls[0][0]).not.toHaveProperty('effort')
    })

    it('medium-effort persona: no prompt opens, launches', async () => {
      const askSpy = vi.spyOn(useMacroCostPrompt.getState(), 'ask')
      const onSelect = vi.fn()
      const el = await mount(<Harness personas={[persona({ effort: 'medium' })]} onSelect={onSelect} />)
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

      expect(askSpy).not.toHaveBeenCalled()
      expect(useMacroCostPrompt.getState().request).toBeNull()
      expect(confirmSpy).not.toHaveBeenCalled()
      expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
      askSpy.mockRestore()
    })
  })

  it('default behaviour: a missing persona in an empty (still-loading) list does NOT block', async () => {
    const onSelect = vi.fn()
    const el = await mount(<Harness personas={[]} onSelect={onSelect} />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalled()
  })

  describe('job macros', () => {
    const dispatchJob = vi.fn()
    beforeEach(() => {
      dispatchJob.mockReset()
      ;(globalThis as any).window.api.macros = { dispatchJob }
      ;(globalThis as any).window.api.agents = { getPersonaBody: vi.fn().mockResolvedValue(null) }
    })

    it('reuses an active Epic: no mint, no select, no chat turn, success toast', async () => {
      dispatchJob.mockResolvedValue({ ok: true, slug: 's', epicId: 'act1' })
      usePromptSessions.setState({
        sessions: { act1: { id: 'act1', cwd: CWD, tag: 'bug', agentType: 'scout', status: 'active' } as any },
      })
      const onSelect = vi.fn()
      const el = await mount(<Harness personas={[persona()]} onSelect={onSelect} macroOver={{ job: JOB }} extraInstructions="more" />)
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })
      expect(dispatchJob).toHaveBeenCalledWith({ cwd: CWD, macroId: 'm1', epicId: 'act1', extraInstructions: 'more' })
      expect(createPromptSessionSpy).not.toHaveBeenCalled()
      expect(sendSpy).not.toHaveBeenCalled()
      expect(onSelect).not.toHaveBeenCalled()
      expect(useToast.getState().toasts.map((t) => t.message)).toContain('Sweep is building in the background')
    })

    it('mints when no active Epic, never selects, and toasts a refusal', async () => {
      dispatchJob.mockResolvedValue({ ok: false, error: 'a build is already running' })
      const onSelect = vi.fn()
      const el = await mount(<Harness personas={[persona()]} onSelect={onSelect} macroOver={{ job: JOB }} />)
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })
      expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
      expect(sendSpy).not.toHaveBeenCalled()
      expect(onSelect).not.toHaveBeenCalled()
      expect(useToast.getState().toasts.some((t) => t.message.includes('a build is already running') && t.message.includes('build was not queued'))).toBe(true)
    })

    it('still runs the readiness check first', async () => {
      ;(globalThis as any).window.api.app.delegationReadiness = vi.fn().mockResolvedValue({ ok: false, checks: [{ ok: false, label: 'hooks' }] })
      const el = await mount(<Harness personas={[persona()]} onSelect={vi.fn()} macroOver={{ job: JOB }} />)
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })
      expect(dispatchJob).not.toHaveBeenCalled()
      expect(createPromptSessionSpy).not.toHaveBeenCalled()
    })
  })
})
