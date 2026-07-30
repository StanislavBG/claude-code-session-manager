import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import './workbench.css'
import { DEFAULT_LAYOUT } from '../../state/layout'

interface PanelParams {
  node: ReactNode
}

/**
 * Dockview's component registry is keyed by string and constructed once;
 * MainPane's props (and therefore its rendered node) change on every App
 * render. PanelHost reads the current node out of panel `params` instead of
 * being handed it as a normal prop, so Workbench can push updates via
 * `panel.api.updateParameters()` without re-registering components.
 */
function PanelHost(props: IDockviewPanelProps<PanelParams>) {
  return <>{props.params.node}</>
}

const COMPONENTS: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  main: PanelHost as React.FunctionComponent<IDockviewPanelProps>,
}

interface WorkbenchProps {
  /** Content for the single 'main' panel. Link 2 adds one panel per screen. */
  children: ReactNode
}

/**
 * Hosts the app shell inside a single dockview panel. Only one panel
 * ('main') exists in this phase — the docking surface (drag/split/multiple
 * panels) is inert until link 2 registers a panel per screen.
 */
export function Workbench({ children }: WorkbenchProps) {
  const apiRef = useRef<DockviewApi | null>(null)

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api
    const definition = DEFAULT_LAYOUT[0]
    event.api.addPanel<PanelParams>({
      id: definition.id,
      component: definition.component,
      title: definition.title,
      params: { node: children },
    })
  }, [])

  useEffect(() => {
    const panel = apiRef.current?.getPanel(DEFAULT_LAYOUT[0].id)
    panel?.api.updateParameters({ node: children })
  }, [children])

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
