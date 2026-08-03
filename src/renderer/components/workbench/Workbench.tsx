import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DockviewReact, type DockviewApi, type DockviewGroupPanel, type DockviewReadyEvent, type IDockviewPanelProps, type SerializedDockview } from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import './workbench.css'
import { DEFAULT_LAYOUT, getPanelDefinition, useLayout } from '../../state/layout'
import { renderScreenComponent, type ScreenRenderCtx } from '../screenComponents'
import type { NavKey } from '../LeftNav'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { PanelFocusProvider } from '../../lib/panelFocus'
import { TerminalPanelContent } from './TerminalPanelContent'
import { useVoice } from '../../state/voice'
import { WORKBENCH_REFIT_EVENT } from '../../lib/workbenchRefit'
import { buildLayoutEnvelope, parsePersistedLayout } from '../../lib/workbenchLayoutSerialize'

const LAYOUT_SAVE_DEBOUNCE_MS = 500
const KNOWN_PANEL_IDS = new Set(DEFAULT_LAYOUT.map((p) => p.id))

function persistLayout(dockview: SerializedDockview) {
  const envelope = buildLayoutEnvelope(dockview)
  if (!envelope) return // zero-panel layout — refuse to persist it
  window.api.layout.save(envelope).catch((e) => {
    console.warn('[Workbench] layout save failed:', e)
  })
}

interface PanelParams {
  id: string
}

/**
 * Panel `params` must stay JSON-serializable — dockview's `api.toJSON()`
 * copies them verbatim into the persisted layout, and a live React element
 * (the old `params.node` shape) has a Fiber backref that throws on
 * `JSON.stringify`. So params carry only the panel id; PanelHost resolves
 * the actual screen content at render time from `WorkbenchCtxContext`, which
 * Workbench keeps current across renders (portalled dockview content still
 * inherits it — `createPortal` preserves the calling React tree's context).
 */
const WorkbenchCtxContext = createContext<ScreenRenderCtx | null>(null)

function PanelHost(props: IDockviewPanelProps<PanelParams>) {
  const ctx = useContext(WorkbenchCtxContext)
  if (!ctx) return null
  return <>{screenNode(props.params.id, ctx)}</>
}

const COMPONENTS: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  screen: PanelHost as React.FunctionComponent<IDockviewPanelProps>,
}

const DEFAULT_PANEL_ID = DEFAULT_LAYOUT[0].id

function screenNode(id: string, ctx: ScreenRenderCtx): ReactNode {
  if (id === 'terminal') return <TerminalPanelContent />
  return (
    <PanelFocusProvider panelId={id}>
      {/* h-full, not absolute inset-0: dockview's intermediate containers
          (.dv-react-part / .dv-content-container) don't establish a
          positioning context, so an absolutely-positioned wrapper resolves
          against the whole .dv-view — tab strip included — and paints over
          it. */}
      <div className="h-full overflow-auto bg-bg">
        <ErrorBoundary>{renderScreenComponent(id as NavKey, ctx)}</ErrorBoundary>
      </div>
    </PanelFocusProvider>
  )
}

type WorkbenchProps = ScreenRenderCtx

/**
 * Hosts the app shell inside dockview, one panel per opened screen
 * (`layout.ts`'s registry covers every NavKey). A screen's panel opens once
 * and then stays mounted (`renderer: 'always'`) for as long as it exists in
 * the layout — closing its panel (dockview's own tab × control) is what
 * unmounts it, not losing focus. Dockview's
 * native drag-to-split lets a panel's tab be dragged to a group edge to show
 * it side by side with another; `usePanelFocus`/`PanelFocusProvider`
 * (lib/panelFocus.tsx) is what keeps a background-but-mounted screen's
 * window-level keyboard handlers from firing while it isn't the active
 * panel. `useLayout`'s `focusedPanelId`/`focusToken` and dockview's own
 * `onDidActivePanelChange` are kept in sync in both directions: an app-driven
 * open (sidebar click, command palette) calls `openPanel` → `mountPanel`;
 * a dockview-driven activation (tab click/close/drag) calls `focusPanel` to
 * mirror it back into the store.
 */
export function Workbench(ctx: WorkbenchProps) {
  const apiRef = useRef<DockviewApi | null>(null)
  const focusedPanelId = useLayout((s) => s.focusedPanelId) ?? DEFAULT_PANEL_ID
  const focusToken = useLayout((s) => s.focusToken)
  const resetToken = useLayout((s) => s.resetToken)
  const isRecording = useVoice((s) => s.isRecording || s.externalRecording)

  // Persisted layout is fetched once, before the workbench's first paint —
  // `hydrated` gates the `<DockviewReact>` render below so `onReady` never
  // fires against an empty/default layout that a beat later gets replaced by
  // the real persisted one (which would be a visible flash + a wasted mount).
  // The result itself lives in a ref (not state) since `onReady` — a
  // `useCallback([])` fired exactly once — needs the value at call time, not
  // whatever it closed over when the callback was first created.
  const persistedRef = useRef<SerializedDockview | null>(null)
  const [hydrated, setHydrated] = useState(false)

  // onReady is a useCallback([]) fired exactly once (dockview's own effect
  // ordering), so it can't close over `focusedPanelId` directly — that would
  // freeze it at whatever the store held on first render. Mirror it into a
  // ref that's kept current every render so onReady always reads the latest
  // value at the moment dockview actually calls back.
  const focusedPanelIdRef = useRef(focusedPanelId)
  focusedPanelIdRef.current = focusedPanelId

  // Holds the disposable returned by dockview's onDidRemovePanel subscription
  // so it can be torn down on unmount (see the cleanup effect below).
  const removePanelDisposableRef = useRef<{ dispose: () => void } | null>(null)
  // Same for the onDidAddGroup subscription that keeps every group's tab
  // header hidden (see onReady).
  const addGroupDisposableRef = useRef<{ dispose: () => void } | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.layout
      .load()
      .then((envelope) => {
        if (cancelled) return
        if (envelope) persistedRef.current = parsePersistedLayout(envelope, KNOWN_PANEL_IDS)
        setHydrated(true)
      })
      .catch((e) => {
        console.warn('[Workbench] layout load failed, using default:', e)
        if (!cancelled) setHydrated(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Opens (or focuses, if already open) the panel for `id`. Non-terminal
  // panels get fresh content pushed on every focus (mirrors MainPane's old
  // unmount/remount-per-visit fidelity); the terminal panel is
  // self-updating (TerminalPanelContent subscribes to the store directly)
  // so its params are never touched after the initial add. Every panel uses
  // `renderer: 'always'` — a panel stays mounted for as long as it exists in
  // the layout, not just while it's the active tab of its group, so a
  // background screen split alongside another keeps running (and so a
  // reopened-but-backgrounded screen doesn't lose scroll/form state). This
  // is why stage 1's focus scope (usePanelFocus/PanelFocusProvider) exists —
  // a mounted-but-unfocused screen's window-level keyboard handlers must not
  // fire.
  const mountPanel = useCallback((id: string) => {
    const api = apiRef.current
    if (!api) return
    const definition = getPanelDefinition(id) ?? DEFAULT_LAYOUT[0]
    const existing = api.getPanel(definition.id)
    if (existing) {
      // Content updates flow through WorkbenchCtxContext now (PanelHost
      // re-renders on every ctx change), so there's no params push here —
      // params only ever hold the id, which never changes for a panel.
      existing.api.setActive()
    } else {
      const panel = api.addPanel<PanelParams>({
        id: definition.id,
        component: definition.component,
        title: definition.title,
        params: { id: definition.id },
        renderer: 'always',
      })
      // The terminal panel hosts a live xterm (FitAddon); forward its
      // dockview-reported dimension changes (group resize, split, drop) to
      // the same refit path the window 'resize' listener uses — xterm has
      // no way to observe those on its own since the window itself doesn't
      // resize.
      if (definition.id === 'terminal') {
        panel.api.onDidDimensionsChange(() => {
          window.dispatchEvent(new CustomEvent(WORKBENCH_REFIT_EVENT))
        })
      }
    }
  }, [])

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api
    // The left-nav sidebar is the sole navigation surface for screens now —
    // dockview's own per-group tab strip would just repeat the same labels
    // in a second horizontal row. Hide every group's header rather than
    // removing tabs/split support outright: the forEach covers any group
    // that could already exist on this api (none normally do yet at this
    // point, before fromJSON/mountPanel below creates the first one), and
    // the subscription (registered before fromJSON/mountPanel run) covers
    // every group created afterward — restored groups, a future drag-to-split,
    // or a floating/popout group.
    const hideGroupHeader = (group: DockviewGroupPanel) => {
      group.header.hidden = true
    }
    addGroupDisposableRef.current = event.api.onDidAddGroup(hideGroupHeader)
    event.api.groups.forEach(hideGroupHeader)
    const persisted = persistedRef.current
    if (persisted) {
      try {
        event.api.fromJSON(persisted)
        // The restored layout's active panel may differ from the store's
        // default `focusedPanelId` — sync it (mirrors an ordinary
        // dockview-driven activation) so the mount effect below doesn't
        // immediately `setActive()` back to the default panel.
        const activeId = event.api.activePanel?.id
        if (activeId) useLayout.getState().focusPanel(activeId)
      } catch (e) {
        console.warn('[Workbench] fromJSON failed, falling back to default layout:', e)
        event.api.clear()
        mountPanel(focusedPanelIdRef.current)
      }
    } else {
      mountPanel(focusedPanelIdRef.current)
    }
    // Mirror dockview-initiated activation (tab click, close, drag) back
    // into the store — without this, a dockview-driven change leaves
    // `focusedPanelId` stale and a subsequent app-driven `openPanel` call
    // for the id dockview already made active would look like a no-op.
    event.api.onDidActivePanelChange((panel) => {
      if (panel) useLayout.getState().focusPanel(panel.id)
    })
    removePanelDisposableRef.current = event.api.onDidRemovePanel((panel) => {
      // The terminal panel is one persistent PTY-backed session, not a
      // closable document — treat its × as "hide", not "close": reopen it
      // immediately so TerminalStage remounts (PTY reattach is idempotent;
      // only in-page scrollback is lost).
      if (panel.id === 'terminal') {
        // openPanel bumps focusToken, which drives the mount effect below —
        // no need to call mountPanel directly here too.
        useLayout.getState().openPanel('terminal')
        return
      }
      // Defensive net: if the last open panel anywhere is closed, don't
      // leave an empty grid — reopen the default screen immediately.
      if (event.api.totalPanels === 0) {
        useLayout.getState().openPanel(DEFAULT_PANEL_ID)
        mountPanel(DEFAULT_PANEL_ID)
      }
    })
    // Debounced autosave: any layout change (resize, split, drag, close)
    // schedules one write ~500ms out, mirroring hydrateSessions' debounced
    // autosave (sessions.ts). `persistLayout` itself refuses to save a
    // zero-panel layout.
    let saveTimer: number | null = null
    event.api.onDidLayoutChange(() => {
      if (saveTimer !== null) window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => persistLayout(event.api.toJSON()), LAYOUT_SAVE_DEBOUNCE_MS)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Dispose the onDidRemovePanel/onDidAddGroup subscriptions registered in
  // onReady when Workbench unmounts — they otherwise outlive the component
  // and leak.
  useEffect(() => {
    return () => {
      removePanelDisposableRef.current?.dispose()
      addGroupDisposableRef.current?.dispose()
    }
  }, [])

  useEffect(() => {
    mountPanel(focusedPanelId)
    // Keyed on focusToken (bumped by every openPanel call, even a same-id
    // one) rather than focusedPanelId itself — see layout.ts's focusToken
    // doc for why a same-id `set()` must still re-trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken, mountPanel])

  // "Reset layout" (CommandPalette) bumps resetToken — the store is how a
  // component with no reference to the live DockviewApi (CommandPalette)
  // reaches into Workbench. Skip the initial-mount value so boot doesn't
  // spuriously clear a just-hydrated layout.
  const isFirstResetRun = useRef(true)
  useEffect(() => {
    if (isFirstResetRun.current) {
      isFirstResetRun.current = false
      return
    }
    const api = apiRef.current
    if (!api) return
    api.clear()
    persistedRef.current = null
    mountPanel(DEFAULT_PANEL_ID)
    persistLayout(api.toJSON())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken])

  // RecordingStatus toggling shifts the whole app tree by 28px (App.tsx's
  // `pt-7`), which resizes the workbench's actual container without the
  // browser window itself resizing. Dockview caches pixel geometry, so
  // force a relayout, then let live terminals refit against their new size.
  useEffect(() => {
    const api = apiRef.current
    if (!api) return
    api.layout(api.width, api.height, true)
    window.dispatchEvent(new CustomEvent(WORKBENCH_REFIT_EVENT))
  }, [isRecording])

  const props = useMemo(
    () => ({
      components: COMPONENTS,
      onReady,
      className: 'dockview-theme-sm workbench-root',
    }),
    [onReady],
  )

  // Gate the very first paint on hydration so `onReady` never fires against
  // a default layout that a beat later gets torn down and replaced by the
  // persisted one — avoids both the visible flash and a wasted mount/unmount.
  if (!hydrated) return null

  return (
    <WorkbenchCtxContext.Provider value={ctx}>
      <DockviewReact {...props} />
    </WorkbenchCtxContext.Provider>
  )
}
