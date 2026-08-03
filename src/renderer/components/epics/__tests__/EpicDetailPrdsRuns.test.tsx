// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'
import { fakePromptSessionsCreate } from '../../../testUtils/fakePromptSessionsCreate'

/**
 * EpicDetail PRDs/Runs tabs (PRD 828-epic-detail-prds-runs) — the PRD file ×
 * scheduler job join (lib/epicDerive.ts's epicPrds) and the Runs list
 * (schedule jobs filtered by sourcePromptId), plus their empty states and
 * live tab counts. Discussion-tab behavior is covered by EpicDetail.test.tsx.
 */

function installWindowApiMock(prds: unknown[] = []) {
  const listPrds = vi.fn().mockResolvedValue(prds)
  const readLog = vi.fn().mockResolvedValue({ ok: true, text: 'log line 1\nlog line 2' })
  const api = {
    chat: {
      run: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      onQueued: vi.fn(),
      onRunStarted: vi.fn(),
      onOutput: vi.fn(),
      onToolUse: vi.fn(),
      onComplete: vi.fn(() => () => {}),
      onNeedsInput: vi.fn(),
      onError: vi.fn(),
      onNotice: vi.fn(),
      onExternalSend: vi.fn(),
      classifyTicket: vi.fn(async () => 'inline' as const),
      createPrd: vi.fn(async () => ({ ok: true as const, nn: 1, filename: '1-fake.md' })),
    },
    pty: { kill: vi.fn() },
    transcripts: { pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl') },
    config: {
      exists: vi.fn().mockResolvedValue(true),
      readText: vi.fn().mockResolvedValue({ exists: false, text: '' }),
      writeJson: vi.fn().mockResolvedValue({ ok: true }),
    },
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
    logs: { write: vi.fn() },
    schedule: { listPrds, readLog },
    promptSessions: { create: fakePromptSessionsCreate(), onEventAppended: vi.fn() },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { api, listPrds, readLog }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

const flush = () => flushAsync(2)

function clickTab(el: HTMLElement, label: string) {
  const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.startsWith(label)) as HTMLButtonElement
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('EpicDetail PRDs/Runs tabs (PRD 828)', () => {
  beforeEach(() => {
    vi.resetModules()
    delete (window as unknown as { api?: unknown }).api
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
  })

  it('shows the dashed empty state when the Epic has no PRD files', async () => {
    installWindowApiMock([])
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await flush()

    clickTab(el, 'PRDs')

    expect(el.querySelector('[data-testid="epic-prds-placeholder"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="epic-prd-card"]')).toBeNull()
    expect(el.textContent).toContain('No PRD yet for this Epic')
  })

  it('joins a PRD file with no job row as status draft', async () => {
    installWindowApiMock([
      { slug: '5-widget', title: 'Widget', cwd: '/tmp/proj', estimateMinutes: 30, mtimeMs: 1, parallelGroup: 1, sourcePromptId: 'EPIC' },
    ])
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useScheduleState } = await import('../../../state/scheduleState')
    const { EpicDetail } = await import('../EpicDetail')

    useScheduleState.setState({ snapshot: { jobs: [] } as any, loaded: true })
    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    // Force the mint id so the mocked PRD's sourcePromptId matches it.
    usePromptSessions.setState({
      sessions: {
        ...usePromptSessions.getState().sessions,
        [session.id]: session,
      },
    })

    // Re-mock listPrds with the real epic id now that we know it.
    ;(window.api.schedule.listPrds as any).mockResolvedValue([
      { slug: '5-widget', title: 'Widget', cwd: '/tmp/proj', estimateMinutes: 30, mtimeMs: 1, parallelGroup: 1, sourcePromptId: session.id },
    ])

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await flush()

    clickTab(el, 'PRDs')
    await flush()

    const card = el.querySelector('[data-testid="epic-prd-card"]')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('5-widget')
    expect(card!.textContent).toContain('draft')
  })

  it('shows a lazily-fetched, cached line count on the PRD card when readPrd resolves', async () => {
    installWindowApiMock([
      { slug: '5-widget', title: 'Widget', cwd: '/tmp/proj', estimateMinutes: 30, mtimeMs: 1, parallelGroup: 1, sourcePromptId: 'EPIC' },
    ])
    const readPrd = vi.fn().mockResolvedValue({ ok: true, text: 'line one\nline two\nline three' })
    window.api.schedule.readPrd = readPrd
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useScheduleState } = await import('../../../state/scheduleState')
    const { EpicDetail } = await import('../EpicDetail')

    useScheduleState.setState({ snapshot: { jobs: [] } as any, loaded: true })
    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    usePromptSessions.setState({
      sessions: { ...usePromptSessions.getState().sessions, [session.id]: session },
    })
    ;(window.api.schedule.listPrds as any).mockResolvedValue([
      { slug: '5-widget', title: 'Widget', cwd: '/tmp/proj', estimateMinutes: 30, mtimeMs: 1, parallelGroup: 1, sourcePromptId: session.id },
    ])

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await flush()
    clickTab(el, 'PRDs')
    await flush()
    await flush()

    const card = el.querySelector('[data-testid="epic-prd-card"]')
    expect(card).not.toBeNull()
    expect(card!.querySelector('[data-testid="epic-prd-line-count"]')?.textContent).toBe('3 lines')
    expect(readPrd).toHaveBeenCalledWith('5-widget')
  })

  it('joins a PRD file with a matching job row as the job status, and shows a live PRDs count', async () => {
    installWindowApiMock([])
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')

    ;(window.api.schedule.listPrds as any).mockResolvedValue([
      { slug: '5-widget', title: 'Widget', cwd: '/tmp/proj', estimateMinutes: 30, mtimeMs: 1, parallelGroup: 1, sourcePromptId: session.id },
    ])
    const { useScheduleState } = await import('../../../state/scheduleState')
    const { EpicDetail } = await import('../EpicDetail')

    useScheduleState.setState({
      snapshot: {
        jobs: [
          {
            slug: '5-widget',
            title: 'Widget',
            cwd: '/tmp/proj',
            parallelGroup: 1,
            estimateMinutes: 30,
            bodyPreview: '',
            status: 'completed',
            runId: 'run-1',
            startedAt: new Date(1000).toISOString(),
            finishedAt: new Date(5000).toISOString(),
            exitCode: 0,
            error: null,
            sourcePromptId: session.id,
          },
        ],
      } as any,
      loaded: true,
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await flush()

    const prdsTabLabel = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.startsWith('PRDs'))
    expect(prdsTabLabel?.textContent).toBe('PRDs 1')

    clickTab(el, 'PRDs')
    await flush()

    const card = el.querySelector('[data-testid="epic-prd-card"]')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('completed')
    expect(card!.textContent).not.toContain('draft')
  })

  it('Runs tab filters schedule jobs by sourcePromptId and shows a job whose PRD file was archived', async () => {
    // No PRD file for '5-widget' — simulates an archived PRD file; the job
    // row alone must still surface it.
    installWindowApiMock([])
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const otherSession = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Other Epic', 'feature')
    const { useScheduleState } = await import('../../../state/scheduleState')
    const { EpicDetail } = await import('../EpicDetail')

    useScheduleState.setState({
      snapshot: {
        jobs: [
          {
            slug: '5-widget',
            title: 'Widget',
            cwd: '/tmp/proj',
            parallelGroup: 1,
            estimateMinutes: 30,
            bodyPreview: '',
            status: 'running',
            runId: 'run-1',
            startedAt: new Date(Date.now() - 60_000).toISOString(),
            finishedAt: null,
            exitCode: null,
            error: null,
            sourcePromptId: session.id,
          },
          {
            slug: '9-other',
            title: 'Other',
            cwd: '/tmp/proj',
            parallelGroup: 1,
            estimateMinutes: 10,
            bodyPreview: '',
            status: 'completed',
            runId: 'run-2',
            startedAt: new Date(1000).toISOString(),
            finishedAt: new Date(2000).toISOString(),
            exitCode: 0,
            error: null,
            sourcePromptId: otherSession.id,
          },
        ],
      } as any,
      loaded: true,
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await flush()

    const runsTabLabel = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Runs'))
    expect(runsTabLabel?.textContent).toBe('Runs 1')

    clickTab(el, 'Runs')
    await flush()

    const cards = el.querySelectorAll('[data-testid="epic-run-card"]')
    expect(cards.length).toBe(1)
    expect(cards[0].textContent).toContain('5-widget')
    expect(cards[0].textContent).not.toContain('9-other')
  })

  it('Runs tab shows the dashed empty state when no jobs match', async () => {
    installWindowApiMock([])
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useScheduleState } = await import('../../../state/scheduleState')
    const { EpicDetail } = await import('../EpicDetail')

    useScheduleState.setState({ snapshot: { jobs: [] } as any, loaded: true })
    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await flush()

    clickTab(el, 'Runs')

    expect(el.querySelector('[data-testid="epic-runs-placeholder"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="epic-run-card"]')).toBeNull()
    expect(el.textContent).toContain('No agent runs in this Epic yet')
  })
})
