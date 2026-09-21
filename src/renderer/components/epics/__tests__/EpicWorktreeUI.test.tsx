// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'
import { fakePromptSessionsCreate } from '../../../testUtils/fakePromptSessionsCreate'

/**
 * PRD 1035 — surfacing the per-Epic git worktree isolation checkpoint
 * (PRDs 1032-1034) in the UI: the EpicWorktreeChip status readout and the
 * EpicDetail conflict banner + Resolve-in-Terminal action. There is no manual
 * "Merge to main" / "Retry merge" button — merging is done in git. Mirrors
 * EpicDetail.test.tsx's window.api stub pattern.
 */

vi.mock('@xterm/xterm', () => {
  class FakeTerm {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    write = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    loadAddon = vi.fn()
    open = vi.fn()
    onData = vi.fn(() => () => {})
    onResize = vi.fn(() => () => {})
  }
  return { Terminal: FakeTerm }
})
vi.mock('@xterm/addon-fit', () => {
  class FakeFit {
    fit = vi.fn()
  }
  return { FitAddon: FakeFit }
})

function installWindowApiMock(opts: { mergeToMain?: ReturnType<typeof vi.fn> } = {}) {
  const mergeToMain = opts.mergeToMain ?? vi.fn().mockResolvedValue({ ok: true, status: 'merged', integrated: true })
  const api = {
    app: { gitBranch: vi.fn().mockResolvedValue(null), homeDir: vi.fn().mockResolvedValue('/home/bilko') },
    agents: {
      listPersonas: vi.fn().mockResolvedValue([]),
      resolveModelInfo: vi.fn().mockResolvedValue({
        agentType: null,
        modelAlias: null,
        modelSource: 'fallback',
        resolvedModelId: null,
        resolvedFrom: null,
        effortEnvReachable: false,
        personaEffort: null,
        personaEffortSource: null,
      }),
    },
    epicDelegationStats: { get: vi.fn().mockResolvedValue({ prdsQueued: 0, inlineEdits: 0 }) },
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
    pty: {
      kill: vi.fn(),
      spawn: vi.fn().mockResolvedValue({ pid: 1, cwd: '/tmp/proj', reattached: false }),
      write: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
    },
    transcripts: { pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl') },
    config: {
      exists: vi.fn().mockResolvedValue(true),
      readText: vi.fn().mockResolvedValue({ exists: false, text: '' }),
      readJson: vi.fn().mockResolvedValue({ exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true }),
      watch: vi.fn(),
      unwatch: vi.fn(),
    },
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
    logs: { write: vi.fn() },
    schedule: { listPrds: vi.fn().mockResolvedValue([]) },
    promptSessions: {
      create: fakePromptSessionsCreate(),
      onEventAppended: vi.fn(),
      mergeToMain,
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { api, mergeToMain }
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

async function mountActiveEpicWithWorktree(worktree: import('../../../state/promptSessions').PromptSession['worktree']) {
  const { usePromptSessions } = await import('../../../state/promptSessions')
  const { EpicDetail } = await import('../EpicDetail')
  const proposed = await usePromptSessions
    .getState()
    .createPromptSession('/tmp/proj', 'Ship it\n\nGet it out the door.', 'feature')
  const approved = usePromptSessions.getState().approveProposed(proposed.id)!
  if (worktree) {
    usePromptSessions.setState({
      sessions: { ...usePromptSessions.getState().sessions, [approved.id]: { ...approved, worktree } },
    })
  }
  const session = usePromptSessions.getState().sessions[approved.id]
  const el = mount(createElement(EpicDetail, { promptSession: session }))
  return { el, session, usePromptSessions }
}

describe('Epic worktree isolation UI (PRD 1035)', () => {
  beforeEach(() => {
    vi.resetModules()
    delete (window as unknown as { api?: unknown }).api
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
  })

  it('EpicDetail shows "shared tree" when the Epic has no worktree', async () => {
    installWindowApiMock()
    const { el } = await mountActiveEpicWithWorktree(undefined)
    const chip = el.querySelector('[data-testid="epic-worktree-chip"]')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toBe('shared tree')
  })

  it('EpicDetail shows the isolated branch chip and NO "Merge to main" button when worktree.status is active', async () => {
    installWindowApiMock()
    const { el } = await mountActiveEpicWithWorktree({
      dir: '/tmp/worktrees/epic-x',
      branch: 'sm-epic/epic-x',
      baseCwd: '/tmp/proj',
      status: 'active',
    })
    const chip = el.querySelector('[data-testid="epic-worktree-chip"]')
    expect(chip!.textContent).toContain('sm-epic/epic-x')
    expect(el.querySelector('[data-testid="epic-merge-to-main"]')).toBeNull()
    expect(el.querySelector('[data-testid="epic-worktree-conflict-banner"]')).toBeNull()
  })

  it('shows the conflict banner with the reason, branch + Resolve-in-Terminal action (no retry) on needs_merge_resolution', async () => {
    installWindowApiMock()
    const { el } = await mountActiveEpicWithWorktree({
      dir: '/tmp/worktrees/epic-x',
      branch: 'sm-epic/epic-x',
      baseCwd: '/tmp/proj',
      status: 'needs_merge_resolution',
      conflictReason: 'both branches edited README.md line 4',
    })
    const banner = el.querySelector('[data-testid="epic-worktree-conflict-banner"]')
    expect(banner).not.toBeNull()
    expect(banner!.textContent).toContain('both branches edited README.md line 4')
    expect(el.querySelector('[data-testid="epic-worktree-resolve-in-terminal"]')).not.toBeNull()
    expect(banner!.textContent).toContain('sm-epic/epic-x')
    expect(el.querySelector('[data-testid="epic-worktree-retry-merge"]')).toBeNull()
    expect(el.querySelector('[data-testid="epic-merge-to-main"]')).toBeNull()
  })

  it('"Resolve in Terminal" switches the Epic into Terminal mode', async () => {
    installWindowApiMock()
    const { el } = await mountActiveEpicWithWorktree({
      dir: '/tmp/worktrees/epic-x',
      branch: 'sm-epic/epic-x',
      baseCwd: '/tmp/proj',
      status: 'needs_merge_resolution',
      conflictReason: 'conflict',
    })
    const resolveButton = el.querySelector('[data-testid="epic-worktree-resolve-in-terminal"]') as HTMLButtonElement
    await act(async () => {
      resolveButton.click()
      await flushAsync()
    })
    expect(el.querySelector('[data-testid="epic-terminal-pane-wrap"]')).not.toBeNull()
  })
})
