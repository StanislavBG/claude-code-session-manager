import { create } from 'zustand'
import type { EpicGroupKey, EpicSortKey } from '../lib/epicQueueControls'

/**
 * Persisted Epic-queue control-layer prefs — pins, sort, group, compact.
 * Follows the `projectsPrefs.ts` pattern: zustand store + tmp+rename JSON
 * file via `window.api.config.writeJson`, hydrated once on mount.
 */
interface PersistedEpicsPrefs {
  pins: Record<string, boolean>
  group: EpicGroupKey
  sort: EpicSortKey
  compact: boolean
}

interface EpicsPrefsState extends PersistedEpicsPrefs {
  hydrated: boolean
  hydrate: () => Promise<void>
  togglePin: (epicId: string) => void
  setGroup: (group: EpicGroupKey) => void
  setSort: (sort: EpicSortKey) => void
  setCompact: (compact: boolean) => void
}

const FILE = '~/.claude/session-manager/epics-prefs.json'

function persist(get: () => EpicsPrefsState): void {
  const s = get()
  const payload: PersistedEpicsPrefs = { pins: s.pins, group: s.group, sort: s.sort, compact: s.compact }
  window.api.config.writeJson(FILE, payload).catch(() => {})
}

export const useEpicsPrefs = create<EpicsPrefsState>((set, get) => ({
  pins: {},
  group: 'status',
  sort: 'recent',
  compact: false,
  hydrated: false,

  hydrate: async () => {
    try {
      const r = await window.api.config.readJson(FILE)
      if (r.exists && r.data && typeof r.data === 'object') {
        const d = r.data as Partial<PersistedEpicsPrefs>
        set({
          pins: d.pins ?? {},
          group: d.group ?? 'status',
          sort: d.sort ?? 'recent',
          compact: d.compact ?? false,
          hydrated: true,
        })
        return
      }
    } catch {}
    set({ hydrated: true })
  },

  togglePin: (epicId) => {
    const next = { ...get().pins, [epicId]: !get().pins[epicId] }
    set({ pins: next })
    persist(get)
  },

  setGroup: (group) => {
    set({ group })
    persist(get)
  },

  setSort: (sort) => {
    set({ sort })
    persist(get)
  },

  setCompact: (compact) => {
    set({ compact })
    persist(get)
  },
}))
