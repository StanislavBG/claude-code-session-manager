import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import './workbench.css'
import { DEFAULT_LAYOUT, getPanelDefinition, useLayout } from '../../state/layout'
import { renderScreenComponent, type ScreenRenderCtx } from '../screenComponents'
import type { NavKey } from '../LeftNav'
import { ErrorBoundary } from '../ui/ErrorBoundary'
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
    <div className="absolute inset-0 bg-bg overflow-auto">
      <ErrorBoundary>{renderScreenComponent(id as NavKey, ctx)}</ErrorBoundary>
    </div>
  )
}

type WorkbenchProps = ScreenRenderCtx

/**
 * Hosts the app shell inside a single dockview group, one panel per opened
 * screen (`layout.ts`'s registry covers every NavKey). Driven entirely by
 * `useLayout`'s `focusedPanelId`: opening a screen adds-or-focuses its
 * panel; dockview's default `onlyWhenVisible` renderer unmounts inactive
 * non-terminal panels automatically, matching MainPane's old
 * unmount-on-switch behavior. The terminal panel is the one exception —
 * added once with `renderer: 'always'` so TerminalStage (the PTY-backed
 * xterm layer) stays mounted regardless of which screen is focused.
 * Side-by-side/multiple *visible* panels are link 3 — this link keeps
 * exactly one screen visible at a time.
 */
export function Workbench(ctx: WorkbenchProps) {
  const apiRef = useRef<DockviewApi | null>(null)
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const focusedPanelId = useLayout((s) => s.focusedPanelId) ?? DEFAULT_PANEL_ID

  // Opens (or focuses, if already open) the panel for `id`. Non-terminal
  // panels get fresh content on every focus (mirrors MainPane's old
  // unmount/remount-per-visit fidelity); the terminal panel is
  // self-updating (TerminalPanelContent subscribes to the store directly)
  // so it's only ever added once.
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
        renderer: definition.id === 'terminal' ? 'always' : undefined,
      })
    }
  }, [])

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api
    mountPanel(focusedPanelId)
    // Defensive net: if the last open panel is closed (e.g. via the
    // dockview tab's own close control), don't leave an empty grid —
    // reopen the default screen immediately.
    event.api.onDidRemovePanel(() => {
      if (event.api.totalPanels === 0) {
        useLayout.getState().openPanel(DEFAULT_PANEL_ID)
        mountPanel(DEFAULT_PANEL_ID)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    mountPanel(focusedPanelId)
    // Re-run whenever any ctx field the currently-focused screen depends on
    // changes (e.g. searchMode flipping Files↔Content while 'search' is
    // already open) — ctxRef always has the latest values regardless.
  }, [focusedPanelId, ctx.searchMode, mountPanel])

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
