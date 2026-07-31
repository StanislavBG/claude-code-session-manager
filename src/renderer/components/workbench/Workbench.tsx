import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import './workbench.css'
import { DEFAULT_LAYOUT, getPanelDefinition, useLayout } from '../../state/layout'
import { renderScreenComponent, type ScreenRenderCtx } from '../screenComponents'
import type { NavKey } from '../LeftNav'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { PanelFocusProvider } from '../../lib/panelFocus'
import { TerminalPanelContent } from './TerminalPanelContent'

interface PanelParams {
  node: ReactNode
}

/**
 * Dockview's component registry is keyed by string and constructed once;
 * screen content changes on every App render. PanelHost reads the current
 * node out of panel `params` instead of being handed it as a normal prop,
 * so Workbench can push updates via `panel.api.updateParameters()` without
 * re-registering components.
 */
function PanelHost(props: IDockviewPanelProps<PanelParams>) {
  return <>{props.params.node}</>
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
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const focusedPanelId = useLayout((s) => s.focusedPanelId) ?? DEFAULT_PANEL_ID
  const focusToken = useLayout((s) => s.focusToken)

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
      if (definition.id !== 'terminal') {
        existing.api.updateParameters({ node: screenNode(definition.id, ctxRef.current) })
      }
      existing.api.setActive()
    } else {
      api.addPanel<PanelParams>({
        id: definition.id,
        component: definition.component,
        title: definition.title,
        params: { node: screenNode(definition.id, ctxRef.current) },
        renderer: 'always',
      })
    }
  }, [])

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api
    mountPanel(focusedPanelId)
    // Mirror dockview-initiated activation (tab click, close, drag) back
    // into the store — without this, a dockview-driven change leaves
    // `focusedPanelId` stale and a subsequent app-driven `openPanel` call
    // for the id dockview already made active would look like a no-op.
    event.api.onDidActivePanelChange((panel) => {
      if (panel) useLayout.getState().focusPanel(panel.id)
    })
    event.api.onDidRemovePanel((panel) => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    mountPanel(focusedPanelId)
    // Keyed on focusToken (bumped by every openPanel call, even a same-id
    // one) rather than focusedPanelId itself — see layout.ts's focusToken
    // doc for why a same-id `set()` must still re-trigger this. Also re-run
    // whenever any ctx field the currently-focused screen depends on
    // changes (e.g. searchMode flipping Files↔Content while 'search' is
    // already open) — ctxRef always has the latest values regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken, ctx.searchMode, mountPanel])

  const props = useMemo(
    () => ({
      components: COMPONENTS,
      onReady,
      className: 'dockview-theme-sm workbench-root',
    }),
    [onReady],
  )

  return <DockviewReact {...props} />
}
