import { create } from 'zustand'
import type { EpicGroupKey, EpicSortKey } from '../lib/epicQueueControls'
import { readUiPrefs, writeUiPrefsPatch } from '../lib/uiPrefs'
import { knownEpicIdsForCwd } from '../lib/epicIdsForCwd'
import { toast } from './toast'

/**
 * Persisted Epic-queue control-layer prefs — pins, sort, group, compact.
 * Follows the `projectsPrefs.ts` pattern: zustand store + tmp+rename JSON
 * file via `window.api.config.writeJson`, hydrated once on mount.
 *
 * `group`/`sort`/`compact` are personal display defaults (how you like the
 * queue laid out) and stay machine-wide, in the file below. `pins` is
 * per-Epic-keyed project data — an Epic belongs to exactly one project — so
 * it lives in the active project's own `ui-prefs/prefs.json` instead (PRD
 * 1399: the old global file mixed every project's pins into one map).
 */
interface PersistedEpicsPrefs {
  group: EpicGroupKey
  sort: EpicSortKey
  compact: boolean
}

interface EpicsPrefsState extends PersistedEpicsPrefs {
  pins: Record<string, boolean>
  hydrated: boolean
  /** cwd whose `pins` are currently loaded, or null before the first hydrate(). */
  pinsCwd: string | null
  hydrate: (cwd: string) => Promise<void>
  togglePin: (cwd: string, epicId: string) => void
  setGroup: (group: EpicGroupKey) => void
  setSort: (sort: EpicSortKey) => void
  setCompact: (compact: boolean) => void
}

const FILE = '~/.claude/session-manager/epics-prefs.json'

function persist(get: () => EpicsPrefsState): void {
  const s = get()
  const payload: PersistedEpicsPrefs = { group: s.group, sort: s.sort, compact: s.compact }
  window.api.config.writeJson(FILE, payload).catch(() => {})
}

/**
 * One-shot migration for a project that has never had a `ui-prefs/prefs.json`
 * `epicPins` field: pull the legacy global file's `pins` map, keep only
 * entries for Epics that actually belong to this cwd, and seed the
 * per-project file with that narrowed copy. The legacy file/field is left in
 * place, untouched — this only ever reads it.
 */
async function migratePins(cwd: string): Promise<Record<string, boolean>> {
  let legacy: Record<string, boolean> = {}
  try {
    const r = await window.api.config.readJson(FILE)
    if (r.exists && r.data && typeof r.data === 'object') {
      legacy = (r.data as { pins?: Record<string, boolean> }).pins ?? {}
    }
  } catch { /* first run / unreadable legacy file — nothing to migrate */ }
  const knownIds = await knownEpicIdsForCwd(cwd)
  const seeded: Record<string, boolean> = {}
  for (const [epicId, pinned] of Object.entries(legacy)) {
    if (pinned && knownIds.has(epicId)) seeded[epicId] = pinned
  }
  // One-shot best-effort seed: nothing to revert (no user-visible optimistic
  // state was set yet), but a failure must still surface rather than vanish.
  await writeUiPrefsPatch(cwd, { epicPins: seeded }).catch((e) => {
    console.warn('migratePins: failed to seed ui-prefs epicPins', e)
  })
  return seeded
}

export const useEpicsPrefs = create<EpicsPrefsState>((set, get) => ({
  pins: {},
  group: 'status',
  sort: 'recent',
  compact: false,
  hydrated: false,
  pinsCwd: null,

  hydrate: async (cwd) => {
    if (!get().hydrated) {
      try {
        const r = await window.api.config.readJson(FILE)
        if (r.exists && r.data && typeof r.data === 'object') {
          const d = r.data as Partial<PersistedEpicsPrefs>
          set({
            group: d.group ?? 'status',
            sort: d.sort ?? 'recent',
            compact: d.compact ?? false,
          })
        }
      } catch { /* first run / unreadable file — fall through to defaults */ }
      set({ hydrated: true })
    }

    if (get().pinsCwd !== cwd) {
      const prefs = await readUiPrefs(cwd)
      if (prefs.epicPins) {
        set({ pins: prefs.epicPins, pinsCwd: cwd })
      } else {
        const seeded = await migratePins(cwd)
        set({ pins: seeded, pinsCwd: cwd })
      }
    }
  },

  togglePin: (cwd, epicId) => {
    const prev = get().pins
    const next = { ...prev, [epicId]: !prev[epicId] }
    set({ pins: next })
    writeUiPrefsPatch(cwd, { epicPins: next }).catch(() => {
      // Only revert if nothing else has moved pins on since this call
      // (writeUiPrefsPatch serializes per-cwd, so a later toggle's write can
      // settle and persist successfully before this one's failure is caught
      // here) — otherwise this stale failure would stomp that later,
      // already-persisted change.
      if (get().pins !== next) return
      set({ pins: prev })
      toast.error("Couldn't save pinned Epics — reverted.")
    })
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
