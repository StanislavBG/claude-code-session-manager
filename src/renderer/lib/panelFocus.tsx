import { createContext, useContext, useRef, type MutableRefObject, type ReactNode } from 'react'
import { useLayout } from '../state/layout'

/**
 * Which workbench panel a subtree is rendered inside of. Workbench.tsx sets
 * this once per screen wrapper (see `screenNode` in Workbench.tsx); nested
 * components (e.g. FileTree/FileTabBar, reused by both the 'editor' and
 * 'projects' screens) read it via `usePanelFocus()` instead of needing to
 * know their own panel id.
 */
const PanelIdContext = createContext<string | null>(null)

export function PanelFocusProvider({ panelId, children }: { panelId: string; children: ReactNode }) {
  return <PanelIdContext.Provider value={panelId}>{children}</PanelIdContext.Provider>
}

/**
 * True when the enclosing panel (or the explicit `panelId` override) is the
 * workbench's currently active panel. Outside of any PanelFocusProvider
 * (unit tests, non-workbench call sites) this defaults to `true` so existing
 * behavior is unaffected.
 */
export function usePanelFocus(panelId?: string): boolean {
  const ctxId = useContext(PanelIdContext)
  const id = panelId ?? ctxId
  return useLayout((s) => id == null || s.focusedPanelId === id)
}

/**
 * Ref mirror of `usePanelFocus`, for window-level event handlers that need
 * the current focus state without re-subscribing the listener on every
 * focus change.
 */
export function usePanelFocusRef(panelId?: string): MutableRefObject<boolean> {
  const focused = usePanelFocus(panelId)
  const ref = useRef(focused)
  ref.current = focused
  return ref
}
