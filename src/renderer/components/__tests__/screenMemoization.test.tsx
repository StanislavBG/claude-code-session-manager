// @vitest-environment jsdom
import { createElement, memo, type ReactNode } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { renderScreenComponent, type ScreenRenderCtx } from '../screenComponents'
import { Skills } from '../tabs/Skills'
import { Settings } from '../tabs/Settings'
import { Memory } from '../tabs/Memory'
import { TagLibrary } from '../tabs/TagLibrary'
import { AgentLibrary } from '../tabs/AgentLibrary'
import type { NavKey } from '../LeftNav'
import { useLayout } from '../../state/layout'
import { useSessions, type SessionTab } from '../../state/sessions'
import { useConfig } from '../../state/config'
import { useScheduleState } from '../../state/scheduleState'
import { usePromptSessions, type PromptSession } from '../../state/promptSessions'
import type { ScheduleStateSnapshot, BilkoHostGetResult, AgentPersona } from '../../../preload/api'
import { flushAsync } from '../../testUtils/domFlush'

/**
 * perf-memo-screen-components: this PRD's own coverage.
 *
 * Three concerns, three describe blocks:
 *  1. `renderScreenComponent` itself memoizes its returned element per
 *     NavKey, keyed on `ctx` reference equality (screenComponents.tsx's
 *     `screenElementCache`) — pure function tests, no DOM needed.
 *  2. The individual screen components it renders are wrapped in
 *     `React.memo`, so an unrelated re-render of whatever hosts them (the
 *     real-world case: Workbench's PanelHost re-rendering on a layout-store
 *     focus change) costs zero re-renders of the screens themselves.
 *  3. Wrapping a screen in `React.memo` must not mask its OWN store
 *     subscriptions — one test per store family (config / scheduleState /
 *     promptSessions) proves the memoized screen still updates when its own
 *     store changes. `state/live.ts` is the fourth store CLAUDE.md's
 *     "Renderer state stores" bullet names, but NONE of the 17 screens
 *     reachable from `renderScreenComponent` subscribe to it reactively
 *     (`useLiveTab`/`useLive` as a *hook*, not `.getState()`) — grep
 *     confirms the only reactive consumers are `AlmanacFooter` (app chrome,
 *     not a screen) and the orphaned, unreferenced `SessionPlansView`. So
 *     there is deliberately no 'live' case here: memoizing these screens
 *     carries no live-store regression risk because none of them read it.
 */

// ─── 1. renderScreenComponent's own element cache ──────────────────────────

describe('renderScreenComponent element memoization', () => {
  it('returns the identical element reference for the same NavKey + ctx identity', () => {
    const ctx: ScreenRenderCtx = { onNavigate: () => {} }
    const first = renderScreenComponent('overview', ctx)
    const second = renderScreenComponent('overview', ctx)
    expect(Object.is(first, second)).toBe(true)
  })

  it('produces a fresh element when ctx identity genuinely changes', () => {
    const ctxA: ScreenRenderCtx = { onNavigate: () => {} }
    const ctxB: ScreenRenderCtx = { onNavigate: () => {} }
    const first = renderScreenComponent('overview', ctxA)
    const second = renderScreenComponent('overview', ctxB)
    expect(Object.is(first, second)).toBe(false)
  })

  it('caches independently per NavKey — a different id under the same ctx is not confused with a cached sibling', () => {
    const ctx: ScreenRenderCtx = { onNavigate: () => {} }
    const overview = renderScreenComponent('overview', ctx)
    const skills = renderScreenComponent('skills', ctx)
    expect(Object.is(overview, skills)).toBe(false)
    // Re-requesting 'overview' with the same ctx still hits its own cache slot.
    expect(Object.is(renderScreenComponent('overview', ctx), overview)).toBe(true)
  })
})

// ─── 2. React.memo wrapping — zero re-renders on an unrelated update ───────

const renderCounts = vi.hoisted(() => ({ counts: {} as Record<string, number> }))

/**
 * Re-exports each real screen module with its named export replaced by a
 * counting wrapper that still delegates to the REAL inner render function
 * (`memo(Comp).type`) and is itself still `memo(...)`-wrapped — so this
 * exercises the exact same bailout semantics as production, with an
 * instrumentation-only side effect layered on top. Not a stub: the real
 * component body still runs on every genuine (re-)render. `vi.mock` calls
 * must be literal top-level statements (vitest hoists them by static
 * analysis of the call site) — hence one per screen rather than a loop.
 */
function countedWrap(real: { type: (props: unknown) => ReactNode }, key: string) {
  return memo((props: unknown) => {
    renderCounts.counts[key] = (renderCounts.counts[key] ?? 0) + 1
    return real.type(props)
  })
}

vi.mock('../tabs/Skills', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, Skills: countedWrap(actual.Skills as never, 'skills') }
})
vi.mock('../tabs/Settings', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, Settings: countedWrap(actual.Settings as never, 'settings') }
})
vi.mock('../tabs/Memory', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, Memory: countedWrap(actual.Memory as never, 'memory') }
})
vi.mock('../tabs/TagLibrary', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, TagLibrary: countedWrap(actual.TagLibrary as never, 'tag-library') }
})
vi.mock('../tabs/AgentLibrary', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, AgentLibrary: countedWrap(actual.AgentLibrary as never, 'agent-library') }
})

// Monaco-backed editors don't render in jsdom (Skills/Memory use
// MarkdownEditor; Settings' Raw view uses JsonEditor) — stub with a plain
// element that still surfaces `value` as text, so assertions on rendered
// JSON content keep working.
vi.mock('../ui/MarkdownEditor', () => ({
  MarkdownEditor: () => createElement('div', { 'data-testid': 'markdown-editor' }),
}))
vi.mock('../ui/JsonEditor', () => ({
  JsonEditor: (props: { value: string }) => createElement('pre', { 'data-testid': 'json-editor' }, props.value),
}))

const FIVE_IDS: NavKey[] = ['skills', 'settings', 'memory', 'tag-library', 'agent-library']

function installBroadWindowApiMock() {
  const changedHandlers: Array<() => void> = []
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue('/home/bilko') },
    config: {
      readJson: vi.fn().mockResolvedValue({ raw: '{}\n', data: {}, exists: true, mtimeMs: 0, parseError: null, error: null }),
      readText: vi.fn().mockResolvedValue({ text: '', raw: '', exists: false, mtimeMs: 0, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      writeText: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      exists: vi.fn().mockResolvedValue(true),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    otel: {
      getConfig: vi.fn().mockResolvedValue({ enabled: false }),
      status: vi.fn().mockResolvedValue({ running: false }),
      configPath: vi.fn().mockResolvedValue('/home/bilko/.config/session-manager/otel.json'),
    },
    files: { delete: vi.fn().mockResolvedValue({ ok: true }) },
    memory: {
      list: vi.fn().mockResolvedValue({ entries: [], error: null }),
      stale: vi.fn().mockResolvedValue({ entries: [] }),
      read: vi.fn().mockResolvedValue({ content: '', error: null }),
      write: vi.fn().mockResolvedValue({ ok: true }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
      create: vi.fn().mockResolvedValue({ ok: true }),
    },
    agents: {
      listPersonas: vi.fn().mockResolvedValue([] as AgentPersona[]),
      savePersona: vi.fn().mockResolvedValue({ ok: true, path: '' }),
      deletePersona: vi.fn().mockResolvedValue({ ok: true }),
      removeOverride: vi.fn().mockResolvedValue({ ok: true }),
      onChanged: vi.fn((handler: () => void) => {
        changedHandlers.push(handler)
        return () => {
          const i = changedHandlers.indexOf(handler)
          if (i >= 0) changedHandlers.splice(i, 1)
        }
      }),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

/**
 * Mounts each FIVE_IDS screen's REAL (mocked-and-counted) exported component
 * directly, rather than through `renderScreenComponent`. screenComponents.tsx
 * now wraps these five behind `React.lazy` + `Suspense` (perf-lazy-screens);
 * React.lazy's factory is invoked from inside React's own internal Suspense
 * scheduling rather than from this test file's call stack, and Vitest's
 * dynamic-`import()` mock interception does not reliably reach across that
 * boundary — confirmed by an isolated repro (a trivial `.tsx` component,
 * lazy-loaded via a separate host module, mocked via `vi.mock` +
 * `importOriginal`: the mock factory runs, but the component that actually
 * renders is the unmocked original). This suite's own documented purpose
 * (see the file's docblock) is verifying `React.memo` bailout on the real
 * screen components, which is independent of whether `screenComponents.tsx`
 * additionally wraps them in `lazy()` — so mounting them directly here still
 * exercises the exact invariant under test, without depending on a mocking
 * path Suspense doesn't honor.
 */
const FIVE_SCREENS: Record<string, (props: object) => ReactNode> = {
  skills: Skills,
  settings: Settings,
  memory: Memory,
  'tag-library': TagLibrary,
  'agent-library': AgentLibrary,
}

function FivePanelHarness({ tick }: { tick: number }) {
  return createElement(
    'div',
    null,
    createElement('div', { 'data-testid': 'tick' }, String(tick)),
    ...FIVE_IDS.map((id) => createElement(FIVE_SCREENS[id], { key: id })),
  )
}

describe('screen components stay memoized across an unrelated re-render', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    installBroadWindowApiMock()
    useSessions.setState({ tabs: [], activeTabId: null })
    useConfig.setState({ files: {}, watchRefs: {} })
    renderCounts.counts = {}
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    delete (window as unknown as { api?: unknown }).api
  })

  it('with 5 panels mounted, a layout-store-style focus change (unrelated parent re-render, same ctx) re-renders zero screen components', async () => {
    await act(async () => {
      root.render(createElement(FivePanelHarness, { tick: 0 }))
      await Promise.resolve()
      await Promise.resolve()
    })
    // Real screens fire their own mount-time effects (config reads, IPC
    // list calls) that settle over several microtask turns and legitimately
    // re-render the component more than once — flush generously so the
    // baseline below is taken AFTER that settling, not mid-flight.
    await flushAsync(12)

    const before = { ...renderCounts.counts }
    expect(FIVE_IDS.every((id) => (before[id] ?? 0) >= 1)).toBe(true)

    // Simulate the real-world trigger (Workbench.tsx doc comment): a
    // focusedPanelId change re-renders the parent tree, but touches none of
    // the four ScreenRenderCtx callbacks — mirrored here by re-rendering the
    // harness with a bumped, unrelated `tick` while each screen's own props
    // (none) keep their identity.
    await act(async () => {
      root.render(createElement(FivePanelHarness, { tick: 1 }))
      await Promise.resolve()
    })

    const after = renderCounts.counts
    expect(after).toEqual(before)
  })
})

// ─── 3. Per-store-family reactivity survives the memo wrapper ─────────────

describe('memoized screens still react to their own store', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  async function mount(node: ReactNode) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(node)
      await Promise.resolve()
      await Promise.resolve()
    })
    return container
  }

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
    delete (window as unknown as { api?: unknown }).api
  })

  it('config store: Settings (memoized) re-renders when useConfig data changes', async () => {
    installBroadWindowApiMock()
    useLayout.setState({ navFace: 'home' })
    useSessions.setState({ tabs: [], activeTabId: null })
    useConfig.setState({ files: {}, watchRefs: {} })

    const { Settings } = await import('../tabs/Settings')
    const el = await mount(createElement(Settings))

    // Switch to the Raw view so the assertion below can see literal JSON
    // text rather than the Guided/Tree schema-driven rendering.
    await act(async () => {
      const rawBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Raw')
      rawBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    // Raw view renders useConfig's file map contents as JSON text — write a
    // marker string directly into the store the way an IPC-driven
    // config:changed broadcast would, and confirm the memoized screen
    // picks it up without an extra prop.
    await act(async () => {
      useConfig.setState((s) => ({
        files: {
          ...s.files,
          '/home/bilko/.claude/settings.json': {
            path: '/home/bilko/.claude/settings.json',
            diskRaw: '{"screenMemoizationMarkerXYZ": true}\n',
            draftRaw: '{"screenMemoizationMarkerXYZ": true}\n',
            diskData: { screenMemoizationMarkerXYZ: true },
            exists: true,
            parseError: null,
            loadError: null,
            mtimeMs: Date.now(),
            dirty: false,
            busy: false,
            lastSavedAt: null,
          },
        },
      }))
      await Promise.resolve()
    })

    expect(el.textContent).toContain('screenMemoizationMarkerXYZ')
  })

  it('scheduleState store: Scheduler (memoized) re-renders when the queue snapshot changes', async () => {
    const api = installBroadWindowApiMock() as unknown as Record<string, unknown>
    Object.assign(api, {
      schedule: {
        state: vi.fn().mockResolvedValue(null),
        health: vi.fn().mockResolvedValue({}),
        onState: vi.fn(() => () => {}),
        listPrds: vi.fn().mockResolvedValue([]),
        sessionSlots: vi.fn().mockResolvedValue({ total: 3, inUse: 0, holders: [] }),
        setConfig: vi.fn().mockResolvedValue(undefined),
      },
      supervisor: { getLog: vi.fn().mockResolvedValue([]) },
    })
    useLayout.setState({ navFace: 'home' })
    useSessions.setState({ tabs: [], activeTabId: null })
    usePromptSessions.setState({ sessions: {}, events: {} })

    const emptySnapshot: ScheduleStateSnapshot = {
      config: { enabled: true, offsetMinutes: 0, defaultCwd: '/home/bilko', firePolicy: 'when-available', utilizationThreshold: 90, schemaVersion: 1 },
      jobs: [],
      scheduledFor: null,
      lastRunAt: null,
      nextReset: null,
      paused: null,
      utilization: null,
      pollHealth: undefined,
      effectiveConcurrency: { cap: 5, free: 5, source: 'pool' },
    } as ScheduleStateSnapshot
    useScheduleState.setState({ snapshot: emptySnapshot })

    const { Scheduler } = await import('../tabs/Scheduler')
    const el = await mount(createElement(Scheduler))
    expect(el.textContent).not.toContain('marker-job-title-xyz')

    await act(async () => {
      useScheduleState.setState({
        snapshot: {
          ...emptySnapshot,
          jobs: [
            {
              slug: 'marker-slug',
              title: 'marker-job-title-xyz',
              cwd: '/home/bilko',
              parallelGroup: 1,
              estimateMinutes: null,
              bodyPreview: '',
              status: 'pending',
              runId: null,
              startedAt: null,
              finishedAt: null,
              exitCode: null,
              error: null,
            } as ScheduleStateSnapshot['jobs'][number],
          ],
        },
      })
      await Promise.resolve()
    })

    expect(el.textContent).toContain('marker-job-title-xyz')
  })

  it('promptSessions store: HostBilko (memoized) re-renders when an active publish Epic appears', async () => {
    const api = installBroadWindowApiMock() as unknown as Record<string, unknown>
    const CWD = '/home/bilko/Projects/alpha'
    Object.assign(api, {
      bilkoHost: {
        get: vi.fn().mockResolvedValue({
          hasMarketingPage: true,
          projectName: 'alpha',
          packagePrivate: false,
          packageHomepage: null,
          packageVersion: '1.0.0',
          defaultSlug: 'alpha',
          documents: [],
          bundleStale: false,
          bundleManifest: null,
          publishState: null,
        } satisfies BilkoHostGetResult),
      },
    })
    const tab: SessionTab = {
      id: 'tab-alpha',
      sessionId: 'tab-alpha',
      label: 'alpha',
      cwd: CWD,
      pid: null,
      status: 'dormant',
      exitCode: null,
      startupCommand: null,
      presetId: null,
      generation: 0,
    }
    useSessions.setState({ tabs: [tab], activeTabId: tab.id })
    usePromptSessions.setState({ sessions: {}, events: {} })

    const { HostBilko } = await import('../tabs/HostBilko')
    const el = await mount(createElement(HostBilko))
    await flushAsync()
    expect(el.textContent).toContain('Publish')
    expect(el.textContent).not.toContain('View publish in progress')

    const session: PromptSession = {
      id: 'epic-1',
      cwd: CWD,
      goalText: 'Publish alpha',
      claudeSessionId: 'sess-1',
      status: 'active',
      createdAt: new Date().toISOString(),
      completedAt: null,
      tag: 'bilko-host-publisher',
    } as PromptSession

    await act(async () => {
      usePromptSessions.setState({ sessions: { [session.id]: session }, events: {} })
      await Promise.resolve()
    })

    expect(el.textContent).toContain('View publish in progress')
  })
})

// ─── 4. Lazy screen boundary actually renders ──────────────────────────────

/**
 * perf-lazy-screens: screenComponents.tsx now wraps 'skills' and 'history'
 * (among others) in `React.lazy` + `Suspense`. Unlike the memo tests above,
 * this exercises the REAL path — `renderScreenComponent` → `LazyScreen` →
 * `Suspense` → the dynamically-imported module — end to end, proving a
 * lazily-loaded screen actually paints its real content once the chunk
 * resolves, not just that a non-null placeholder element was returned.
 */
describe('lazy screen boundary (screenComponents.tsx React.lazy + Suspense)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    installBroadWindowApiMock()
    useSessions.setState({ tabs: [], activeTabId: null })
    useConfig.setState({ files: {}, watchRefs: {} })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    delete (window as unknown as { api?: unknown }).api
  })

  it('navigating to the lazily-loaded "skills" screen renders its real content', async () => {
    const ctx: ScreenRenderCtx = {}
    await act(async () => {
      root.render(createElement('div', null, renderScreenComponent('skills', ctx)))
      await Promise.resolve()
      await Promise.resolve()
    })
    await flushAsync(12)

    // The page title from PAGE_META only appears once the lazy Skills
    // component (wrapped by SectionFrame) has actually resolved and
    // mounted — the Suspense fallback ("Loading…") carries no such text.
    expect(container.textContent).toContain('Reusable instructions')
    expect(container.textContent).not.toContain('Loading…')
  })

  it('navigating to the lazily-loaded "history" screen renders its real content', async () => {
    const ctx: ScreenRenderCtx = {}
    await act(async () => {
      root.render(createElement('div', null, renderScreenComponent('history', ctx)))
      await Promise.resolve()
      await Promise.resolve()
    })
    await flushAsync(12)

    expect(container.textContent).toContain('Every session, ever')
  })
})
