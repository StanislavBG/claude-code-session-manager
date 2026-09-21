// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const gate = vi.hoisted(() => ({ focused: true, visible: true }))
vi.mock('../../lib/panelFocus', () => ({ usePanelFocus: () => gate.focused }))
vi.mock('../../lib/useDocumentVisible', () => ({ useDocumentVisible: () => gate.visible }))
vi.mock('../../lib/useKnownProjects', () => ({
  useKnownProjects: () => ({ projects: [], rows: [], enriched: {}, loading: false, resolving: false }),
}))

import { EpicsWorkspace } from '../epics/EpicsWorkspace'
import { usePromptSessions } from '../../state/promptSessions'
import { useEpicUsage } from '../../state/epicUsage'
import { useSessions } from '../../state/sessions'
import { fakePromptSessionsCreate } from '../../testUtils/fakePromptSessionsCreate'

const CWD = '/home/bilko/Projects/alpha'
const fetchSpy = vi.fn().mockResolvedValue(undefined)
let container: HTMLDivElement
let root: Root

const render = () => act(async () => { root.render(<EpicsWorkspace cwd={CWD} />) })
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(async () => {
  vi.useFakeTimers()
  gate.focused = true
  gate.visible = true
  fetchSpy.mockClear()
  ;(window as unknown as { api: unknown }).api = {
    app: { homeDir: vi.fn().mockResolvedValue('/home/bilko') },
    pty: { kill: vi.fn() },
    transcripts: { pathFor: vi.fn().mockResolvedValue('/tmp/t.jsonl'), usageFor: vi.fn().mockResolvedValue({}) },
    epicDelegationStats: { get: vi.fn().mockResolvedValue({ prdsQueued: 0, inlineEdits: 0 }) },
    config: {
      readText: vi.fn().mockResolvedValue({ exists: true, text: '', mtimeMs: 0, error: null }),
      readJson: vi.fn().mockResolvedValue({ exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: 'nf' }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      watch: vi.fn(),
      unwatch: vi.fn(),
    },
    schedule: { listPrds: vi.fn().mockResolvedValue([]) },
    promptSessions: { create: fakePromptSessionsCreate(), onEventAppended: vi.fn() },
  }
  usePromptSessions.setState({ sessions: {}, events: {} })
  useSessions.setState({ tabs: [], activeTabId: null })
  useEpicUsage.setState({ usage: {}, fetch: fetchSpy })
  await act(async () => { await usePromptSessions.getState().createPromptSession(CWD, 'ship the widget') })
  // hydrate() would replace the seeded Epic with the (empty) mocked index.
  usePromptSessions.setState({ hydrate: vi.fn().mockResolvedValue(undefined), hydrateArchived: vi.fn().mockResolvedValue(undefined) })
  expect(Object.keys(usePromptSessions.getState().sessions).length).toBe(1)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

describe('EpicsWorkspace usage poll gating', () => {
  it('makes 0 fetchUsage calls over 60s while hidden', async () => {
    gate.focused = false
    await render()
    await advance(60_000)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('polls every 30s while visible and loads immediately on regaining focus', async () => {
    gate.focused = false
    await render()
    gate.focused = true
    await render()
    const initial = fetchSpy.mock.calls.length
    expect(initial).toBeGreaterThanOrEqual(1)
    await advance(60_000)
    expect(fetchSpy.mock.calls.length).toBe(initial + 2)
  })
})
