import { create } from 'zustand'
import type { ConfigSearchTab } from '../lib/configSearch'

/**
 * The item last chosen in the Claude config band's "Search all config" field: the page
 * switches to `tab` and records `id` (a ConfigSearchItem id) here so that tab can select
 * it. Island store — read only by the Claude config pages and their tabs; a tab clears it
 * once it has selected the item.
 */
interface ConfigSearchFocusStore {
  tab: ConfigSearchTab | null
  id: string | null
  set: (tab: ConfigSearchTab, id: string) => void
  clear: () => void
}

export const useConfigSearchFocus = create<ConfigSearchFocusStore>((set) => ({
  tab: null,
  id: null,
  set: (tab, id) => set({ tab, id }),
  clear: () => set({ tab: null, id: null }),
}))
