// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
const launchSession = vi.fn()
vi.mock('../../../../../lib/launchSession', () => ({ launchSession: (...a: unknown[]) => launchSession(...a) }))

import { CompetitorMatrixView } from '../CompetitorMatrixView'
import { useToast } from '../../../../../state/toast'
import { usePromptSessions } from '../../../../../state/promptSessions'
import { featureSessionGoal, featureSessionTitle } from '../../../../../lib/competitorMatrix'
import type {
  CompetitiveMatrix,
  CompetitorMatrixResult,
  Macro,
  MacroJobStatus,
  MatrixFeature,
} from '../../../../../../preload/api'

const CWD = '/p/alpha'

const MACRO: Macro = {
  id: 'builtin-competitor-matrix',
  label: 'Competitor matrix',
  agentName: 'architect',
  tag: 'discussion',
  prompt: 'Research.',
  projects: ['*'],
  surface: 'project-home',
  builtin: true,
  createdAt: '',
  updatedAt: '',
}

const cell = (status: 'yes' | 'partial' | 'no' | 'unknown', note = '') => ({ status, note, sourceIds: [] as string[] })

function feature(over: Partial<MatrixFeature>): MatrixFeature {
  return {
    id: 'f',
    groupId: 'g1',
    title: 'F',
    description: '',
    sentiment: { signal: 'none', summary: '', sourceIds: [] },
    support: { self: cell('yes'), cd: cell('yes'), oc: cell('yes'), cu: cell('yes'), ai: cell('yes') },
    recommendation: { priority: 'none', rationale: '', sessionGoal: '' },
    firstSeenAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  }
}

const MATRIX: CompetitiveMatrix = {
  schemaVersion: 1,
  product: { id: 'self', name: 'Session Manager', summary: 'Cockpit.' },
  competitors: [
    { id: 'cd', name: 'Claude Desktop', category: 'desktop', chosenBy: 'user', why: '' },
    { id: 'oc', name: 'OpenCode', category: 'cli', chosenBy: 'user', why: '' },
    { id: 'cu', name: 'Cursor', category: 'ide', chosenBy: 'auto', why: '' },
    { id: 'ai', name: 'Aider', category: 'cli', chosenBy: 'auto', why: '' },
  ],
  groups: [
    { id: 'g1', title: 'Sessions', description: 'Running work.' },
    { id: 'g2', title: 'Integrations', description: 'Outside tools.' },
  ],
  features: [
    feature({
      id: 'voice',
      groupId: 'g1',
      title: 'Voice input',
      description: 'Talk to the agent.',
      sentiment: { signal: 'loved', summary: 'Users rave about it.', sourceIds: ['s1'] },
      support: { self: cell('no', 'Not yet'), cd: cell('yes', 'Ships it'), oc: cell('partial'), cu: cell('unknown'), ai: cell('no') },
      recommendation: { priority: 'P0', rationale: 'Table stakes.', sessionGoal: 'Add voice.' },
    }),
    feature({ id: 'tabs', groupId: 'g1', title: 'Tabs' }),
    feature({ id: 'mcp', groupId: 'g2', title: 'MCP servers' }),
    feature({ id: 'sync', groupId: 'g2', title: 'Cloud sync', support: { self: cell('partial'), cd: cell('yes'), oc: cell('no'), cu: cell('no'), ai: cell('no') } }),
  ],
  sources: [
    {
      id: 's1',
      url: 'https://example.com/voice',
      title: 'Voice launch',
      publisher: 'Example Blog',
      publishedAt: '2026-10-01',
      retrievedAt: '2026-11-01T00:00:00.000Z',
      kind: 'blog',
    },
  ],
  runs: [
    { at: '2026-11-01T00:00:00.000Z', model: 'opus', competitors: [], added: [], changed: [], notes: '' },
    { at: '2026-11-07T00:00:00.000Z', model: 'opus', competitors: [], added: [], changed: [], notes: '' },
  ],
  updatedAt: '2026-11-07T12:00:00.000Z',
}

const matrixApi = vi.fn<(payload: { cwd: string }) => Promise<CompetitorMatrixResult>>()
type ChangedHandler = (payload: { cwd: string }) => void
let changedHandlers: ChangedHandler[] = []
const offChanged = vi.fn()
const onChanged = vi.fn((h: ChangedHandler) => {
  changedHandlers.push(h)
  return () => {
    offChanged()
    changedHandlers = changedHandlers.filter((x) => x !== h)
  }
})
const fireChanged = (cwd: string) => act(() => { for (const h of [...changedHandlers]) h({ cwd }) })

beforeEach(() => {
  matrixApi.mockReset()
  matrixApi.mockResolvedValue({ ok: true, matrix: MATRIX, error: null })
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  launchSession.mockReset()
  let n = 0
  launchSession.mockImplementation(async () => ({ epicId: `e${++n}`, claudeSessionId: `c${n}` }))
  usePromptSessions.setState({ sessions: {} })
  changedHandlers = []
  offChanged.mockReset()
  onChanged.mockClear()
  ;(window as unknown as { api: unknown }).api = { projectPages: { matrix: matrixApi, onChanged } }
})

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

type Props = React.ComponentProps<typeof CompetitorMatrixView>

function render(over: Partial<Props> = {}) {
  const props: Props = { cwd: CWD, macro: MACRO, onLaunch: vi.fn(), launching: null, ...over }
  if (!root) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => root!.render(<CompetitorMatrixView {...props} />))
  return props
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const all = (id: string) => Array.from(container!.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[]
const runBtn = () => q('competitor-matrix-run') as HTMLButtonElement
const job = (state: MacroJobStatus['state']): MacroJobStatus => ({
  macroId: MACRO.id, epicId: 'e1', slug: 's', state, status: state, reason: null, startedAt: null, finishedAt: null,
})

function setSelect(sel: HTMLSelectElement, v: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, v)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('CompetitorMatrixView', () => {
  it('loads the matrix once per cwd and shows the header', async () => {
    render()
    await settle()
    expect(matrixApi.mock.calls).toEqual([[{ cwd: CWD }]])
    expect(q('competitor-matrix-heading')!.textContent).toBe('Session Manager vs 4 competitors')
    expect(q('competitor-matrix-meta')!.textContent).toContain('2026-11-07')
    expect(q('competitor-matrix-meta')!.textContent).toContain('2 runs')
    render()
    await settle()
    expect(matrixApi).toHaveBeenCalledTimes(1)
    act(() => q('competitor-matrix-refresh')!.click())
    await settle()
    expect(matrixApi).toHaveBeenCalledTimes(2)
  })

  it('renders one section per group with product columns, cells and a detail toggle', async () => {
    render()
    await settle()
    const groups = all('competitor-matrix-group')
    expect(groups.map((g) => g.getAttribute('data-group-id'))).toEqual(['g1', 'g2'])
    const heads = Array.from(groups[0].querySelectorAll('th')).map((t) => t.textContent)
    expect(heads).toEqual(['Feature', 'Session Manager', 'Claude Desktop', 'OpenCode', 'Cursor', 'Aider'])
    const voice = container!.querySelector('[data-testid="competitor-matrix-feature"][data-feature-id="voice"]') as HTMLElement
    const cells = Array.from(voice.querySelectorAll('[data-testid="competitor-matrix-cell"]')) as HTMLElement[]
    expect(cells.map((c) => c.textContent)).toEqual(['✕ Missing', '✓ Has it', '◐ Partial', '? Unknown', '✕ Missing'])
    expect(cells[0].getAttribute('title')).toBe('Not yet')
    expect(q('competitor-matrix-detail')).toBeNull()
    act(() => voice.click())
    const detail = q('competitor-matrix-detail')!
    expect(detail.textContent).toContain('Talk to the agent.')
    expect(detail.textContent).toContain('loved')
    expect(detail.textContent).toContain('Users rave about it.')
    expect(detail.textContent).toContain('P0')
    expect(detail.textContent).toContain('Table stakes.')
    expect(detail.textContent).toContain('Voice launch')
    expect(detail.textContent).toContain('Example Blog')
    expect(detail.textContent).toContain('2026-10-01')
    expect(detail.textContent).toContain('https://example.com/voice')
    expect(detail.querySelector('a')).toBeNull()
    act(() => voice.click())
    expect(q('competitor-matrix-detail')).toBeNull()
  })

  it('prefills slots from the matrix; Update matrix launches with the Competitors line', async () => {
    const onLaunch = vi.fn()
    render({ onLaunch })
    await settle()
    const names = all('competitor-slot-name') as HTMLInputElement[]
    expect(names.map((n) => n.value)).toEqual(['Claude Desktop', 'OpenCode', 'Cursor', 'Aider'])
    const modes = all('competitor-slot-mode') as HTMLSelectElement[]
    expect(modes).toHaveLength(4)
    setSelect(modes[2], 'auto')
    setSelect(modes[3], 'auto')
    expect(runBtn().textContent).toContain('Update matrix')
    act(() => runBtn().click())
    expect(onLaunch.mock.calls).toEqual([[MACRO, 'Competitors: Claude Desktop; OpenCode; auto; auto']])
  })

  it('disables the button when every slot is off, while launching, and while the job runs', async () => {
    render()
    await settle()
    for (const m of all('competitor-slot-mode') as HTMLSelectElement[]) setSelect(m, 'off')
    expect(runBtn().disabled).toBe(true)
    render({ launching: MACRO.id })
    expect(runBtn().disabled).toBe(true)
  })

  it('shows Researching… while queued/running and reloads when the job finishes', async () => {
    render({ jobStatus: job('running') })
    await settle()
    expect(runBtn().disabled).toBe(true)
    expect(q('competitor-matrix-status')!.textContent).toContain('Researching…')
    expect(matrixApi).toHaveBeenCalledTimes(1)
    render({ jobStatus: job('done') })
    await settle()
    expect(matrixApi).toHaveBeenCalledTimes(2)
    expect(q('competitor-matrix-status')).toBeNull()
    expect(runBtn().disabled).toBe(false)
    render({ jobStatus: job('done') })
    await settle()
    expect(matrixApi).toHaveBeenCalledTimes(2)
  })

  it('empty state: Run research with four auto slots', async () => {
    const onLaunch = vi.fn()
    matrixApi.mockResolvedValue({ ok: true, matrix: null, error: null })
    render({ onLaunch })
    await settle()
    expect(q('competitor-matrix-empty')!.textContent).toContain('competitor')
    expect(q('competitor-matrix-group')).toBeNull()
    expect(runBtn().textContent).toContain('Run research')
    act(() => runBtn().click())
    expect(onLaunch.mock.calls).toEqual([[MACRO, 'Competitors: auto; auto; auto; auto']])
  })

  it('a rejected call shows an inline error and toasts once', async () => {
    matrixApi.mockRejectedValue(new Error('boom'))
    render()
    await settle()
    expect(q('competitor-matrix-error')!.textContent).toContain('boom')
    expect(useToast.getState().toasts).toHaveLength(1)
    render()
    await settle()
    expect(useToast.getState().toasts).toHaveLength(1)
  })

  describe('project-pages:changed', () => {
    it('reloads on a matching cwd event so a finished matrix appears; ignores other cwds; unsubscribes on unmount', async () => {
      matrixApi.mockResolvedValueOnce({ ok: true, matrix: null, error: null })
      render()
      await settle()
      expect(q('competitor-matrix-empty')).not.toBeNull()
      expect(q('competitor-matrix-group')).toBeNull()
      expect(onChanged).toHaveBeenCalledTimes(1)
      fireChanged('/p/beta')
      await settle()
      expect(matrixApi).toHaveBeenCalledTimes(1)
      fireChanged(CWD)
      await settle()
      expect(matrixApi).toHaveBeenCalledTimes(2)
      expect(all('competitor-matrix-group')).toHaveLength(2)
      act(() => root!.unmount())
      root = null
      expect(offChanged).toHaveBeenCalledTimes(1)
      expect(changedHandlers).toHaveLength(0)
    })

    it('a burst of events keeps the previous matrix visible and ends on the newest result', async () => {
      render()
      await settle()
      expect(all('competitor-matrix-group')).toHaveLength(2)
      const resolvers: ((v: CompetitorMatrixResult) => void)[] = []
      matrixApi.mockImplementation(() => new Promise((r) => { resolvers.push(r) }))
      fireChanged(CWD)
      fireChanged(CWD)
      expect(matrixApi).toHaveBeenCalledTimes(3)
      expect(all('competitor-matrix-group')).toHaveLength(2)
      const ONE_GROUP: CompetitiveMatrix = { ...MATRIX, groups: [MATRIX.groups[0]], features: MATRIX.features.slice(0, 2) }
      await act(async () => { resolvers[1]({ ok: true, matrix: ONE_GROUP, error: null }) })
      await act(async () => { resolvers[0]({ ok: true, matrix: null, error: null }) })
      await settle()
      expect(all('competitor-matrix-group')).toHaveLength(1)
    })
  })

  describe('start sessions', () => {
    const VOICE = MATRIX.features[0]
    const SYNC = MATRIX.features[3]
    const startBtn = (id: string) =>
      container!.querySelector(`[data-testid="competitor-matrix-start"][data-feature-id="${id}"]`) as HTMLButtonElement | null
    const startAllBtn = () => q('competitor-matrix-start-all') as HTMLButtonElement
    const proposeAllBtn = () => q('competitor-matrix-propose-all') as HTMLButtonElement
    const toasts = () => useToast.getState().toasts.map((t) => ({ kind: t.kind, message: t.message }))
    const expected = (f: MatrixFeature) => ({
      cwd: CWD,
      agentName: 'architect',
      tag: 'feature',
      title: featureSessionTitle(f),
      goal: featureSessionGoal(f, MATRIX),
      source: 'CompetitorMatrix start-session',
    })
    const seedEpic = (id: string, goalText: string, cwd = CWD) =>
      usePromptSessions.setState({
        sessions: { ...usePromptSessions.getState().sessions, [id]: { id, cwd, goalText, status: 'proposed' } as never },
      })

    it('only no/partial features get a Start session button; pressing it launches and opens', async () => {
      const onOpenSession = vi.fn()
      render({ onOpenSession })
      await settle()
      expect(startBtn('tabs')).toBeNull()
      expect(startBtn('mcp')).toBeNull()
      expect(startBtn('voice')!.textContent).toBe('Start session')
      expect(startBtn('sync')!.textContent).toBe('Start session')
      act(() => startBtn('voice')!.click())
      await settle()
      expect(launchSession.mock.calls).toEqual([[expected(VOICE)]])
      expect(onOpenSession.mock.calls).toEqual([['e1']])
      expect(q('competitor-matrix-detail')).toBeNull()
    })

    it('a failed single start toasts its error', async () => {
      const onOpenSession = vi.fn()
      launchSession.mockRejectedValueOnce(new Error('nope'))
      render({ onOpenSession })
      await settle()
      act(() => startBtn('voice')!.click())
      await settle()
      expect(onOpenSession).not.toHaveBeenCalled()
      expect(toasts()).toEqual([{ kind: 'error', message: expect.stringContaining('nope') }])
    })

    it('Start all missing confirms, then starts each in order without navigating', async () => {
      const onOpenSession = vi.fn()
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
      render({ onOpenSession })
      await settle()
      expect(startAllBtn().textContent).toBe('Start all missing (2)')
      act(() => startAllBtn().click())
      await settle()
      expect(confirm).toHaveBeenCalledWith("Start 2 sessions now? They share this machine's session slots with scheduled jobs.")
      expect(launchSession.mock.calls).toEqual([[expected(VOICE)], [expected(SYNC)]])
      expect(onOpenSession).not.toHaveBeenCalled()
      expect(toasts()).toEqual([{ kind: 'info', message: 'Started 2 sessions' }])
      confirm.mockRestore()
    })

    it('Cancel on the confirm launches nothing', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      render()
      await settle()
      act(() => startAllBtn().click())
      await settle()
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(launchSession).not.toHaveBeenCalled()
      confirm.mockRestore()
    })

    it('Add all as proposed mints with approve false, no confirm, and reports skipped + failed', async () => {
      const confirm = vi.spyOn(window, 'confirm')
      seedEpic('old', `${featureSessionTitle(VOICE)}\n\nwhatever`)
      launchSession.mockRejectedValueOnce(new Error('store down'))
      render()
      await settle()
      expect(proposeAllBtn().textContent).toBe('Add all as proposed (1)')
      act(() => proposeAllBtn().click())
      await settle()
      expect(confirm).not.toHaveBeenCalled()
      expect(launchSession.mock.calls).toEqual([[{ ...expected(SYNC), approve: false }]])
      expect(toasts()).toEqual([
        { kind: 'error', message: expect.stringContaining('store down') },
        { kind: 'info', message: 'Added 0 proposed sessions — approve them in Sessions, skipped 1 already started, 1 failed' },
      ])
      confirm.mockRestore()
    })

    it('Add all as proposed toasts the added count', async () => {
      render()
      await settle()
      act(() => proposeAllBtn().click())
      await settle()
      expect(launchSession.mock.calls).toEqual([[{ ...expected(VOICE), approve: false }], [{ ...expected(SYNC), approve: false }]])
      expect(toasts()).toEqual([{ kind: 'info', message: 'Added 2 proposed sessions — approve them in Sessions' }])
    })

    it('a feature with an Epic of the same title in this cwd shows Open session', async () => {
      const onOpenSession = vi.fn()
      seedEpic('mine', `${featureSessionTitle(SYNC)}\n\nGoal body`)
      seedEpic('other-cwd', `${featureSessionTitle(VOICE)}\n\nGoal body`, '/p/beta')
      render({ onOpenSession })
      await settle()
      expect(startBtn('voice')!.textContent).toBe('Start session')
      expect(startBtn('sync')!.textContent).toBe('Open session')
      expect(startAllBtn().textContent).toBe('Start all missing (1)')
      act(() => startBtn('sync')!.click())
      expect(onOpenSession.mock.calls).toEqual([['mine']])
      expect(launchSession).not.toHaveBeenCalled()
    })

    it('disables every start button while a start is in flight', async () => {
      let resolve!: (v: { epicId: string; claudeSessionId: string }) => void
      launchSession.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
      render({ onOpenSession: vi.fn() })
      await settle()
      act(() => startBtn('voice')!.click())
      await settle()
      expect(startBtn('voice')!.disabled).toBe(true)
      expect(startBtn('sync')!.disabled).toBe(true)
      expect(startAllBtn().disabled).toBe(true)
      expect(proposeAllBtn().disabled).toBe(true)
      act(() => startBtn('sync')!.click())
      expect(launchSession).toHaveBeenCalledTimes(1)
      await act(async () => { resolve({ epicId: 'e9', claudeSessionId: 'c9' }) })
      await settle()
      expect(startBtn('sync')!.disabled).toBe(false)
      expect(startAllBtn().disabled).toBe(false)
    })
  })
})
