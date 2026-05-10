import { useSessions } from '../state/sessions'

/** Returns the currently-active session tab, or null. */
export function useActiveTab() {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  return tabs.find((t) => t.id === activeTabId) ?? null
}
