// @vitest-environment jsdom
import { createElement, useContext } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'

/**
 * Regression coverage for the panel-switch O(N) fan-out fix: Workbench used
 * to hand `WorkbenchCtxContext.Provider` the raw props object it was called
 * with, which App.tsx (necessarily) constructs fresh on every render — so
 * every App re-render (including a plain panel switch, which changes
 * `focusedPanelId` in the layout store) changed the context value identity
 * and re-rendered every mounted PanelHost, however many screens the user had
 * ever opened. The fix: Workbench now builds a `useMemo`'d context value
 * keyed on the four callback identities, and PanelHost is wrapped in
 * `React.memo` — so a change that doesn't touch any of the four callbacks
 * (a panel switch, a recording toggle, anything else App re-renders on)
 * produces zero re-renders of already-mounted panels.
 *
 * `dockview-react` is mocked here because dockview's real implementation
 * mounts panel components once via an internal portal and only updates them
 * imperatively rather than re-invoking them on every host re-render — not
 * something dockview's real code makes easy to observe a render count
 * against in jsdom. The mock deliberately does NOT reproduce that
 * "identical element, skip reconciliation" shortcut itself: it rebuilds a
 * fresh panel-elements array (and fresh React elements) on every single
 * render, only keeping the per-id `params`/`api`/`containerApi` prop
 * *objects* stable via a module-level cache — so the only thing that can
 * prevent PanelHost's function body from re-running when its props are
 * unchanged is `React.memo`'s own shallow prop comparison on the real
 * `PanelHost` export. This means the render-count assertions below
 * genuinely exercise the `memo()` wrapper (AC item c), not just the
 * unrelated "same element reference" React fast path.
 */

const PANEL_IDS = ['zz-panel-0', 'zz-panel-1', 'zz-panel-2', 'zz-panel-3', 'zz-panel-4']

const renderCounts = vi.hoisted(() => ({ counts: {} as Record<string, number> }))
const dockSlot = vi.hoisted(() => ({ extra: null as (() => any) | null }))
const panelPropsCache = vi.hoisted(() => ({
  cache: {} as Record<string, { params: { id: string }; api: object; containerApi: object }>,
}))

;(globalThis as any).window.api = {
  layout: {
    load: vi.fn(async () => null),
    save: vi.fn(async () => undefined),
  },
}

vi.mock('../../screenComponents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../screenComponents')>()
  return {
    ...actual,
    renderScreenComponent: (active: any, ctx: any) => {
      renderCounts.counts[active] = (renderCounts.counts[active] ?? 0) + 1
      return actual.renderScreenComponent(active, ctx)
    },
  }
})

vi.mock('dockview-react', () => ({
  DockviewReact: (props: any) => {
    const Comp = props.components.screen
    // Deliberately NOT memoized — a fresh array (and fresh React elements,
    // since `createElement` always returns a new element object) is built
    // on every call. Only the prop *objects* per id are stable (cached), so
    // a re-render here only skips re-executing PanelHost if `React.memo`'s
    // own shallow prop comparison sees equal props — see the file doc
    // comment above.
    const panels = PANEL_IDS.map((id) => {
      const cached =
        panelPropsCache.cache[id] ??
        (panelPropsCache.cache[id] = { params: { id }, api: {}, containerApi: {} })
      return createElement(Comp, { key: id, ...cached })
    })
    const extra = dockSlot.extra ? createElement(dockSlot.extra) : null
    return createElement('div', null, panels, extra)
  },
}))

import { Workbench, WorkbenchCtxContext } from '../Workbench'
import { useLayout } from '../../../state/layout'

let container: HTMLDivElement
let root: Root

const initialLayoutState = useLayout.getState()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  renderCounts.counts = {}
  dockSlot.extra = null
  useLayout.setState({
    focusedPanelId: initialLayoutState.focusedPanelId,
    focusToken: initialLayoutState.focusToken,
    resetToken: initialLayoutState.resetToken,
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  dockSlot.extra = null
})

async function mountWorkbench(props: {
  onNavigate?: () => void
  onNewSession?: () => void
  onOpenVoice?: () => void
  onOpenScheduler?: () => void
}) {
  act(() => {
    root.render(createElement(Workbench, props))
  })
  await flushAsync()
}

describe('Workbench context identity', () => {
  it('does not change context value identity when Workbench re-renders with unchanged callback props', async () => {
    const captured: any[] = []
    const Consumer = () => {
      const ctx = useContext(WorkbenchCtxContext)
      captured.push(ctx)
      return null
    }
    dockSlot.extra = Consumer

    const onNavigate = () => {}
    const onNewSession = () => {}
    const onOpenVoice = () => {}
    const onOpenScheduler = () => {}

    await mountWorkbench({ onNavigate, onNewSession, onOpenVoice, onOpenScheduler })
    expect(captured.length).toBeGreaterThanOrEqual(1)
    const first = captured[captured.length - 1]

    // Re-render Workbench with the SAME callback references (mirrors App.tsx
    // re-rendering on unrelated state — recording toggle, tab switch — while
    // navigate/handleNewSession/handleOpenVoice/handleOpenScheduler stay
    // stable useCallback identities).
    await mountWorkbench({ onNavigate, onNewSession, onOpenVoice, onOpenScheduler })
    const second = captured[captured.length - 1]

    expect(Object.is(first, second)).toBe(true)
  })

  it('changes context value identity when a callback prop actually changes', async () => {
    const captured: any[] = []
    const Consumer = () => {
      const ctx = useContext(WorkbenchCtxContext)
      captured.push(ctx)
      return null
    }
    dockSlot.extra = Consumer

    await mountWorkbench({
      onNavigate: () => {},
      onNewSession: () => {},
      onOpenVoice: () => {},
      onOpenScheduler: () => {},
    })
    const first = captured[captured.length - 1]

    await mountWorkbench({
      onNavigate: () => {}, // a genuinely new identity
      onNewSession: () => {},
      onOpenVoice: () => {},
      onOpenScheduler: () => {},
    })
    const second = captured[captured.length - 1]

    expect(Object.is(first, second)).toBe(false)
  })
})

describe('PanelHost render isolation on panel switch', () => {
  it('does not re-render already-mounted panels when focusedPanelId changes in the layout store', async () => {
    const stableProps = {
      onNavigate: () => {},
      onNewSession: () => {},
      onOpenVoice: () => {},
      onOpenScheduler: () => {},
    }

    await mountWorkbench(stableProps)

    const before = { ...renderCounts.counts }
    expect(PANEL_IDS.every((id) => before[id] === 1)).toBe(true)
    const totalBefore = PANEL_IDS.reduce((sum, id) => sum + (before[id] ?? 0), 0)
    expect(totalBefore).toBe(5)

    // Simulate a panel switch: bump focusedPanelId + focusToken exactly the
    // way `openPanel` does internally (layout.ts) — done via a direct
    // `setState` rather than calling `openPanel` itself, since `openPanel`
    // only accepts ids registered in the real screen registry and these
    // fake panel ids intentionally aren't part of it.
    act(() => {
      useLayout.setState((s) => ({ focusedPanelId: 'zz-panel-2', focusToken: s.focusToken + 1 }))
    })
    await flushAsync()

    const after = renderCounts.counts
    const totalAfter = PANEL_IDS.reduce((sum, id) => sum + (after[id] ?? 0), 0)

    // Before the fix, EVERY mounted PanelHost re-rendered on every App
    // re-render (which a panel switch triggers via focusedPanelId), so
    // totalAfter would be 10 (5 panels x 2 renders) for this 5-panel case.
    // After the fix, the memoized context value + memoized PanelHost mean a
    // panel switch renders none of them again.
    expect(totalAfter).toBe(totalBefore)
    expect(after).toEqual(before)
  })
})
