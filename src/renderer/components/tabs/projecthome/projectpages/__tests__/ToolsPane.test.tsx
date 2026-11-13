// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ToolsPane } from '../ToolsPane'
import { useToast } from '../../../../../state/toast'
import type { AgentPersona, Macro, MdNetwork, MdNetworkResult } from '../../../../../../preload/api'

const CWD = '/p/alpha'

const persona = (name: string, tags: string[]): AgentPersona => ({
  name, description: null, tools: [], model: null, effort: null, color: null, tags: tags as AgentPersona['tags'],
  projects: [], action: null, actionLabel: null, path: '', body: '', overridingProjects: [],
})

function macro(over: Partial<Macro> = {}): Macro {
  return {
    id: 'm',
    label: 'M',
    agentName: 'architect',
    tag: 'discussion',
    prompt: 'Go.',
    projects: ['*'],
    surface: 'project-home',
    createdAt: '',
    updatedAt: '',
    ...over,
  }
}

const REVIEW = macro({
  id: 'builtin-review-md-network',
  label: 'Review MD network',
  builtin: true,
  prompt: 'Review. Scope: {{scope}}. Mode: {{mode}}.',
  inputs: [
    { name: 'scope', label: 'Scope', default: 'the whole project', required: true },
    { name: 'mode', label: 'Mode', options: ['Full review', 'Drift check'], default: 'Full review', required: true },
  ],
})
const HOME = macro({ id: 'builtin-project-home', label: 'Project Home', builtin: true, agentName: 'project-home-builder', tag: 'project-home-builder' })
const DEMO = macro({ id: 'builtin-demo-video', label: 'Demo Video', builtin: true, agentName: 'demo-video-builder', tag: 'project-home-builder' })
const SWEEP = macro({ id: 'sweep', label: 'Sweep', agentName: 'dev-lead', tag: 'bug' })
const ASK = macro({
  id: 'ask',
  label: 'Ask',
  tag: 'feature',
  prompt: 'Do {{topic}}',
  inputs: [{ name: 'topic', label: 'Topic', required: false }],
})
const MATRIX_TOOL = macro({ id: 'builtin-competitor-matrix', label: 'Competitor matrix', builtin: true })
const SESSIONS_ONLY = macro({ id: 'sessions-only', label: 'Elsewhere', surface: 'sessions' })

/** A scan of 58 docs / 20 links with three findings (two broken links, one orphan group). */
const NET: MdNetwork = {
  ok: true,
  root: 'CLAUDE.md',
  nodes: [
    { id: 'CLAUDE.md', path: 'CLAUDE.md', depth: 0, type: 'hub', linksOut: 2, linkedFrom: 0 },
    { id: 'src/CLAUDE.md', path: 'src/CLAUDE.md', depth: 1, type: 'owner', linksOut: 1, linkedFrom: 1 },
    { id: 'plugins/CLAUDE.md', path: 'plugins/CLAUDE.md', depth: 1, type: 'owner', linksOut: 0, linkedFrom: 1 },
  ],
  edges: [
    { from: 'CLAUDE.md', to: 'src/CLAUDE.md' },
    { from: 'CLAUDE.md', to: 'plugins/CLAUDE.md' },
    { from: 'src/CLAUDE.md', to: 'src/gone.md', broken: true },
  ],
  findings: [
    { type: 'broken-link', file: 'src/CLAUDE.md', line: 4, target: 'gone.md', to: 'src/gone.md', where: 'src/CLAUDE.md:4 → gone.md', detail: 'The link target doesn’t exist.' },
    { type: 'broken-link', file: 'src/CLAUDE.md', line: 9, target: 'gone.md', to: 'src/gone.md', where: 'src/CLAUDE.md:9 → gone.md', detail: 'The link target doesn’t exist.' },
    { type: 'orphan', where: 'notes/', count: 1, paths: ['notes/a.md'], detail: 'No link path from CLAUDE.md reaches this doc, so agents starting there never find it.' },
  ],
  docs: 58,
  links: 20,
  scopes: ['src/', 'plugins/'],
  census: { docs: [], collections: [], counts: { tracked: 0, network: 0, records: 0, unlinked: 0, byRole: { map: 0, scoped: 0, agent: 0, record: 0, doc: 0 } }, gitWindow: { commits: 0, oldestMs: null }, warnings: [] },
}
const INFO = '58 docs · 20 links · 3 findings. A review opens an architect session that reports first and changes no files until you approve.'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const save = vi.fn()
const listPersonas = vi.fn()
const mdNetwork = vi.fn<(payload: { cwd: string }) => Promise<MdNetworkResult>>()
const matrix = vi.fn()
const open = vi.fn()

beforeEach(() => {
  save.mockReset()
  save.mockResolvedValue({})
  listPersonas.mockReset()
  listPersonas.mockResolvedValue([persona('architect', ['discussion', 'feature'])])
  // Tests that are not about the link map keep the scan pending (no late state updates).
  mdNetwork.mockReset()
  mdNetwork.mockReturnValue(new Promise<MdNetworkResult>(() => {}))
  open.mockReset()
  open.mockResolvedValue({ ok: true })
  matrix.mockReset()
  matrix.mockReturnValue(new Promise(() => {}))
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  ;(window as unknown as { api: unknown }).api = {
    macros: { save },
    agents: { listPersonas, onChanged: () => () => {} },
    projectPages: { mdNetwork, matrix },
    shell: { open },
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

type Props = React.ComponentProps<typeof ToolsPane>

/** Mounts once, then re-renders the same root (as ProjectPagesSection does when the macro list refreshes). */
function render(over: Partial<Props> = {}) {
  const props: Props = { cwd: CWD, macros: [REVIEW, SWEEP], launching: null, onLaunch: vi.fn(), ...over }
  if (!root) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => root!.render(<ToolsPane {...props} />))
  return props
}

const flush = () => act(async () => { await Promise.resolve() })
/** Lets every pending promise (the mdNetwork scan) settle inside act. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const rows = () => Array.from(container!.querySelectorAll('[data-testid="project-home-tool"]')) as HTMLButtonElement[]
const rowIds = () => rows().map((r) => r.getAttribute('data-macro-id'))
const row = (id: string) => container!.querySelector(`[data-testid="project-home-tool"][data-macro-id="${id}"]`) as HTMLButtonElement
const selectedIds = () => rows().filter((r) => r.getAttribute('aria-current') === 'true').map((r) => r.getAttribute('data-macro-id'))
const modeButtons = () => Array.from(container!.querySelectorAll('[data-testid="project-home-review-mode"]')) as HTMLButtonElement[]
const pressedMode = () => modeButtons().filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent)

function setSelect(sel: HTMLSelectElement, v: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, v)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
function setText(el: HTMLInputElement | HTMLTextAreaElement, v: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ToolsPane list', () => {
  it('lists Review MD network first, then the other project-home macros, without the two library builtins', () => {
    render({ macros: [ASK, HOME, SWEEP, REVIEW, DEMO, SESSIONS_ONLY] })
    expect(rowIds()).toEqual(['builtin-review-md-network', 'ask', 'sweep'])
    const header = q('project-home-tools-header')!
    expect(header.textContent?.startsWith('TOOLS')).toBe(true)
    expect(q('project-home-tools-count')!.textContent).toBe('3')
    expect(q('project-home-tools-footnote')!.textContent).toBe('Every Project Home tool shows up here in every project. What it generates stays with each project.')
    expect(q('project-home-add-tool')!.textContent).toContain('Add a tool')
  })

  it('shows each row with its label and agent', () => {
    render({ macros: [REVIEW, SWEEP] })
    expect(row('sweep').textContent).toContain('Sweep')
    expect(row('sweep').textContent).toContain('dev-lead')
    expect(row(REVIEW.id).textContent).toContain('Review MD network')
  })

  it('selects the first row by default and switches the content on click', () => {
    render({ macros: [REVIEW, SWEEP] })
    expect(selectedIds()).toEqual([REVIEW.id])
    expect(q('project-home-tool-title')!.textContent).toBe('Review MD network')
    act(() => row('sweep').click())
    expect(selectedIds()).toEqual(['sweep'])
    expect(q('project-home-tool-title')!.textContent).toBe('Sweep')
    expect(q('project-home-run-review')).toBeNull()
  })

  it('keeps the selection while its macro stays in a refreshed list, else falls back to the first row', () => {
    render({ macros: [REVIEW, SWEEP] })
    act(() => row('sweep').click())
    render({ macros: [REVIEW, ASK, { ...SWEEP }] })
    expect(selectedIds()).toEqual(['sweep'])
    render({ macros: [REVIEW, ASK] })
    expect(selectedIds()).toEqual([REVIEW.id])
  })

  it('with no tools shows a zero count, Add a tool, the footnote and an empty content pane', () => {
    render({ macros: [HOME, DEMO] })
    expect(rowIds()).toEqual([])
    expect(q('project-home-tools-count')!.textContent).toBe('0')
    expect(q('project-home-add-tool')).not.toBeNull()
    expect(q('project-home-tools-footnote')).not.toBeNull()
    expect(q('project-home-tools-empty')).not.toBeNull()
  })
})

describe('ToolsPane Competitor matrix', () => {
  it('renders CompetitorMatrixView for the competitor matrix tool with cwd, job status and launch wiring', () => {
    const onLaunch = vi.fn()
    const job = { macroId: MATRIX_TOOL.id, epicId: 'e', slug: 's', state: 'running' as const, status: 'running', reason: null, startedAt: null, finishedAt: null }
    render({ macros: [REVIEW, MATRIX_TOOL, SWEEP], onLaunch, jobStatus: { [MATRIX_TOOL.id]: job }, onOpenSession: vi.fn() })
    expect(q('competitor-matrix')).toBeNull()
    act(() => row(MATRIX_TOOL.id).click())
    expect(q('competitor-matrix')).not.toBeNull()
    expect(q('competitor-matrix')!.getAttribute('data-has-session-handler')).toBe('true')
    expect(matrix.mock.calls).toEqual([[{ cwd: CWD }]])
    expect(q('competitor-matrix-status')!.textContent).toContain('Researching…')
    expect((q('competitor-matrix-run') as HTMLButtonElement).disabled).toBe(true)
    expect(q('project-home-run-tool')).toBeNull()
    expect(q('project-home-run-review')).toBeNull()
  })
})

describe('ToolsPane generic tool', () => {
  it('shows the title bar (label, mono "<agent> · <tag>") and Run calls onLaunch(macro) only', () => {
    const onLaunch = vi.fn()
    render({ macros: [SWEEP], onLaunch })
    expect(q('project-home-tool-title')!.textContent).toBe('Sweep')
    expect(q('project-home-tool-sub')!.textContent).toBe('dev-lead · bug')
    expect(q('project-home-tool-sub')!.className).toContain('font-mono')
    expect(q('macro-inputs-form')).toBeNull()
    act(() => q('project-home-run-tool')!.click())
    expect(onLaunch.mock.calls).toEqual([[SWEEP]])
  })

  it('a tool with inputs shows MacroInputsForm (no Run); submit launches with the values', () => {
    const onLaunch = vi.fn()
    render({ macros: [ASK], onLaunch })
    expect(q('macro-inputs-form')).not.toBeNull()
    expect(q('project-home-run-tool')).toBeNull()
    setText(q('macro-input-topic') as HTMLInputElement, 'cats')
    act(() => q('macro-inputs-start')!.click())
    expect(onLaunch.mock.calls).toEqual([[ASK, undefined, { topic: 'cats' }]])
  })

  it('Cancel on the inputs form resets it to the defaults without launching', () => {
    const onLaunch = vi.fn()
    render({ macros: [ASK], onLaunch })
    setText(q('macro-input-topic') as HTMLInputElement, 'cats')
    act(() => q('macro-inputs-cancel')!.click())
    expect((q('macro-input-topic') as HTMLInputElement).value).toBe('')
    expect(q('macro-inputs-form')).not.toBeNull()
    expect(onLaunch).not.toHaveBeenCalled()
  })

  it('Run is disabled while any macro launches and reads Starting… for its own', () => {
    render({ macros: [SWEEP], launching: 'other' })
    const run = q('project-home-run-tool') as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(run.textContent).toContain('Run')
    render({ macros: [SWEEP], launching: 'sweep' })
    expect((q('project-home-run-tool') as HTMLButtonElement).textContent).toContain('Starting…')
  })
})

describe('ToolsPane Review MD network', () => {
  it('shows the title bar, Scope select (default + scanned scopes), Mode from the input, and the description', async () => {
    mdNetwork.mockResolvedValue(NET)
    render({ macros: [REVIEW, SWEEP] })
    expect(q('project-home-tool-title')!.textContent).toBe('Review MD network')
    expect(q('project-home-tool-sub')!.textContent).toBe('built-in macro · architect')
    expect(Array.from((q('project-home-review-scope') as HTMLSelectElement).options).map((o) => o.value)).toEqual(['the whole project'])
    await settle()
    expect(q('project-home-tool-sub')!.textContent).toBe('built-in macro · architect · 3 findings')
    const scope = q('project-home-review-scope') as HTMLSelectElement
    expect(Array.from(scope.options).map((o) => o.value)).toEqual(['the whole project', 'src/', 'plugins/'])
    expect(scope.value).toBe('the whole project')
    expect(modeButtons().map((b) => b.textContent)).toEqual(['Full review', 'Drift check'])
    expect(pressedMode()).toEqual(['Full review'])
    expect(q('project-home-review-description')!.textContent).toBe(
      'Maps CLAUDE.md and every doc it leads to, so agents start from one short entry map and find each fact in exactly one place — with nothing stale.',
    )
    expect(q('macro-inputs-form')).toBeNull()
  })

  it('Run review launches with the default scope and mode', () => {
    const onLaunch = vi.fn()
    render({ macros: [REVIEW], onLaunch })
    act(() => q('project-home-run-review')!.click())
    expect(onLaunch.mock.calls).toEqual([[REVIEW, undefined, { scope: 'the whole project', mode: 'Full review' }]])
  })

  it('Run review sends the picked scope and mode', async () => {
    mdNetwork.mockResolvedValue(NET)
    const onLaunch = vi.fn()
    render({ macros: [REVIEW], onLaunch })
    await settle()
    setSelect(q('project-home-review-scope') as HTMLSelectElement, 'src/')
    act(() => modeButtons().find((b) => b.textContent === 'Drift check')!.click())
    expect(pressedMode()).toEqual(['Drift check'])
    act(() => q('project-home-run-review')!.click())
    expect(onLaunch.mock.calls).toEqual([[REVIEW, undefined, { scope: 'src/', mode: 'Drift check' }]])
  })

  it('reads the scope default and mode options/default from the live macro, never a fixed list', () => {
    const live = macro({
      ...REVIEW,
      inputs: [
        { name: 'scope', label: 'Scope', default: 'docs only', required: true },
        { name: 'mode', label: 'Mode', options: ['Quick', 'Deep', 'Audit'], default: 'Deep', required: true },
      ],
    })
    const onLaunch = vi.fn()
    render({ macros: [live], onLaunch })
    expect(Array.from((q('project-home-review-scope') as HTMLSelectElement).options).map((o) => o.value)).toEqual(['docs only'])
    expect(modeButtons().map((b) => b.textContent)).toEqual(['Quick', 'Deep', 'Audit'])
    expect(pressedMode()).toEqual(['Deep'])
    act(() => q('project-home-run-review')!.click())
    expect(onLaunch.mock.calls).toEqual([[live, undefined, { scope: 'docs only', mode: 'Deep' }]])
  })

  it('a scope that a refreshed scan no longer lists falls back to the default', async () => {
    mdNetwork.mockResolvedValueOnce({ ...NET, scopes: ['src/'] }).mockResolvedValueOnce({ ...NET, scopes: ['plugins/'] })
    render({ macros: [REVIEW] })
    await settle()
    setSelect(q('project-home-review-scope') as HTMLSelectElement, 'src/')
    expect((q('project-home-review-scope') as HTMLSelectElement).value).toBe('src/')
    act(() => q('project-home-review-refresh')!.click())
    await settle()
    expect(Array.from((q('project-home-review-scope') as HTMLSelectElement).options).map((o) => o.value)).toEqual([
      'the whole project',
      'plugins/',
    ])
    expect((q('project-home-review-scope') as HTMLSelectElement).value).toBe('the whole project')
  })

  it('Run review is disabled while any macro launches and reads Starting… for its own', () => {
    render({ macros: [REVIEW], launching: 'sweep' })
    const run = q('project-home-run-review') as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(run.textContent).toContain('Run review')
    render({ macros: [REVIEW], launching: REVIEW.id })
    expect((q('project-home-run-review') as HTMLButtonElement).textContent).toContain('Starting…')
  })
})

describe('ToolsPane Review MD network link map', () => {
  const infoText = () => q('project-home-review-info-text')!.textContent
  const toasts = () => useToast.getState().toasts.map((t) => [t.kind, t.message])
  const meta = (id: string) => row(id).querySelector('[data-testid="project-home-tool-meta"]')!.textContent

  it('scans mdNetwork({ cwd }) once when the view mounts, shows Scanning docs… until it lands, then the strip and both cards', async () => {
    const scan = deferred<MdNetworkResult>()
    mdNetwork.mockReturnValue(scan.promise)
    render({ macros: [REVIEW, SWEEP] })
    expect(mdNetwork.mock.calls).toEqual([[{ cwd: CWD }]])
    expect(infoText()).toBe('Scanning docs…')
    expect(q('md-link-map-svg')).toBeNull()
    expect(q('md-findings')).toBeNull()
    render({ macros: [REVIEW, { ...SWEEP }] })
    expect(mdNetwork).toHaveBeenCalledTimes(1)
    await act(async () => { scan.resolve(NET) })
    expect(infoText()).toBe(INFO)
    expect(q('md-link-map-svg')).not.toBeNull()
    expect(q('md-findings')!.querySelectorAll('[data-testid="md-finding"]')).toHaveLength(3)
  })

  it('shows "<n> findings" on the Review row and reports the count through onFindingsCount', async () => {
    mdNetwork.mockResolvedValue(NET)
    const onFindingsCount = vi.fn()
    render({ macros: [REVIEW, SWEEP], onFindingsCount })
    expect(meta(REVIEW.id)).toBe('architect')
    await settle()
    expect(meta(REVIEW.id)).toBe('3 findings')
    expect(meta('sweep')).toBe('dev-lead')
    expect(onFindingsCount.mock.calls).toEqual([[CWD, 3]])
  })

  it('does not scan while another tool is shown; scans once Review MD network is picked, not again on switching back', async () => {
    mdNetwork.mockResolvedValue(NET)
    render({ macros: [SWEEP] })
    act(() => row('sweep').click())
    render({ macros: [REVIEW, SWEEP] })
    expect(selectedIds()).toEqual(['sweep'])
    expect(mdNetwork).not.toHaveBeenCalled()
    act(() => row(REVIEW.id).click())
    await settle()
    expect(mdNetwork.mock.calls).toEqual([[{ cwd: CWD }]])
    act(() => row('sweep').click())
    act(() => row(REVIEW.id).click())
    await settle()
    expect(mdNetwork).toHaveBeenCalledTimes(1)
    expect(infoText()).toBe(INFO)
  })

  it('scans again for a new cwd', async () => {
    mdNetwork.mockResolvedValue(NET)
    render({ macros: [REVIEW] })
    await settle()
    render({ macros: [REVIEW], cwd: '/p/beta' })
    await settle()
    expect(mdNetwork.mock.calls).toEqual([[{ cwd: CWD }], [{ cwd: '/p/beta' }]])
  })

  it('Refresh scans again, reads Scanning docs… and disables itself until the new result lands', async () => {
    const second = deferred<MdNetworkResult>()
    mdNetwork.mockResolvedValueOnce(NET).mockReturnValueOnce(second.promise)
    render({ macros: [REVIEW] })
    await settle()
    const refresh = q('project-home-review-refresh') as HTMLButtonElement
    expect(refresh.disabled).toBe(false)
    act(() => refresh.click())
    expect(mdNetwork).toHaveBeenCalledTimes(2)
    expect(infoText()).toBe('Scanning docs…')
    expect((q('project-home-review-refresh') as HTMLButtonElement).disabled).toBe(true)
    // The last map stays up while the new scan runs.
    expect(q('md-link-map-svg')).not.toBeNull()
    await act(async () => { second.resolve({ ...NET, docs: 60, findings: [] }) })
    expect(infoText()).toBe('60 docs · 20 links · 0 findings. A review opens an architect session that reports first and changes no files until you approve.')
    expect(meta(REVIEW.id)).toBe('0 findings')
  })

  it('{ ok:false } shows its error text with no toast, and re-renders do not rescan', async () => {
    mdNetwork.mockResolvedValue({ ok: false, error: 'no CLAUDE.md at the project root' })
    const onFindingsCount = vi.fn()
    render({ macros: [REVIEW], onFindingsCount })
    await settle()
    expect(infoText()).toContain('no CLAUDE.md at the project root')
    expect(q('md-link-map-svg')).toBeNull()
    expect(toasts()).toEqual([])
    render({ macros: [{ ...REVIEW }], onFindingsCount })
    render({ macros: [REVIEW, SWEEP], onFindingsCount })
    await settle()
    expect(mdNetwork).toHaveBeenCalledTimes(1)
    expect(toasts()).toEqual([])
    expect(onFindingsCount.mock.calls).toEqual([[CWD, null]])
    expect(meta(REVIEW.id)).toBe('architect')
  })

  it('a rejected scan shows its error and toasts it once', async () => {
    mdNetwork.mockRejectedValue(new Error('invalid cwd'))
    render({ macros: [REVIEW] })
    await settle()
    expect(infoText()).toContain('invalid cwd')
    render({ macros: [{ ...REVIEW }] })
    await settle()
    expect(toasts()).toEqual([['error', 'Could not map docs: invalid cwd']])
  })
})

describe('ToolsPane Add a tool', () => {
  it('opens the macro editor preset to Surface: Project Home in the content pane; Cancel closes it', async () => {
    render({ macros: [REVIEW, SWEEP] })
    act(() => q('project-home-add-tool')!.click())
    await flush()
    expect(q('macro-editor')).not.toBeNull()
    expect((q('macro-surface') as HTMLSelectElement).value).toBe('project-home')
    expect(q('project-home-run-review')).toBeNull()
    expect(selectedIds()).toEqual([])
    act(() => q('macro-cancel')!.click())
    expect(q('macro-editor')).toBeNull()
    expect(q('project-home-run-review')).not.toBeNull()
  })

  it('saves a project-home macro for every project, then closes', async () => {
    render({ macros: [REVIEW] })
    act(() => q('project-home-add-tool')!.click())
    await flush()
    expect(listPersonas).toHaveBeenCalled()
    setText(q('macro-label') as HTMLInputElement, 'Lint')
    setText(q('macro-prompt') as HTMLTextAreaElement, 'Run lint')
    await act(async () => { q('macro-save')!.click() })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toEqual(
      expect.objectContaining({ label: 'Lint', agentName: 'architect', prompt: 'Run lint', projects: ['*'], surface: 'project-home' }),
    )
    expect(q('macro-editor')).toBeNull()
  })

  it('picking a row closes the editor', async () => {
    render({ macros: [REVIEW, SWEEP] })
    act(() => q('project-home-add-tool')!.click())
    await flush()
    act(() => row('sweep').click())
    expect(q('macro-editor')).toBeNull()
    expect(selectedIds()).toEqual(['sweep'])
  })

  it('is disabled without a cwd', () => {
    render({ cwd: null })
    expect((q('project-home-add-tool') as HTMLButtonElement).disabled).toBe(true)
  })
})
