import { create } from 'zustand'
import { CHAT_VERBOSITY_DEFAULT, isChatVerbosity, type ChatVerbosity } from '../lib/chatVerbosity'
import { readUiPrefs, writeUiPrefsPatch } from '../lib/uiPrefs'
import { knownEpicIdsForCwd } from '../lib/epicIdsForCwd'
import { toast } from './toast'

/**
 * Persisted chat-feed display prefs. Follows the `epicsPrefs.ts` pattern:
 * zustand store + tmp+rename JSON via `window.api.config.writeJson`, hydrated
 * once on mount.
 *
 * Two tiers deliberately, mirroring how the dial is actually used: a global
 * default (how you like to read chat in general) and a sparse per-Epic
 * override (this ONE noisy Epic you want to watch in verbose). Only Epics you
 * explicitly dialled appear in `perEpic` — the map is never pre-filled, so it
 * stays small and a change to the global default still moves every
 * un-overridden Epic.
 *
 * The global default is a personal display preference and stays machine-wide
 * in the file below. `perEpic` is per-Epic-keyed project data — an Epic
 * belongs to exactly one project — so it lives in the active project's own
 * `ui-prefs/prefs.json` instead (PRD 1399: the old global file mixed every
 * project's overrides into one map).
 */
interface PersistedChatPrefs {
  verbosity: ChatVerbosity
}

interface ChatPrefsState extends PersistedChatPrefs {
  perEpic: Record<string, ChatVerbosity>
  hydrated: boolean
  /** cwd whose `perEpic` overrides are currently loaded, or null before the first hydrate(). */
  perEpicCwd: string | null
  hydrate: (cwd: string) => Promise<void>
  setVerbosity: (level: ChatVerbosity) => void
  /** Passing the current global level CLEARS the override rather than pinning
   *  a redundant copy — so an Epic dialled back to the default resumes
   *  following it. */
  setEpicVerbosity: (cwd: string, epicId: string, level: ChatVerbosity) => void
  clearEpicVerbosity: (cwd: string, epicId: string) => void
}

export const CHAT_PREFS_FILE = '~/.claude/session-manager/chat-prefs.json'

/**
 * Values written by the first (3-level) shipment of the dial. Mapped forward
 * on read so an existing prefs file doesn't silently reset to the default.
 * This is a one-line data migration, not a compat shim — delete it once no
 * file on disk can still hold the old value.
 */
const LEGACY_LEVELS: Record<string, ChatVerbosity> = { verbose: 'raw' }

function readLevel(v: unknown): ChatVerbosity | null {
  if (isChatVerbosity(v)) return v
  if (typeof v === 'string' && LEGACY_LEVELS[v]) return LEGACY_LEVELS[v]
  return null
}

function persist(get: () => ChatPrefsState): void {
  const s = get()
  const payload: PersistedChatPrefs = { verbosity: s.verbosity }
  window.api.config.writeJson(CHAT_PREFS_FILE, payload).catch(() => {})
}

/**
 * One-shot migration for a project that has never had a `ui-prefs/prefs.json`
 * `chatVerbosityPerEpic` field: pull the legacy global file's `perEpic` map,
 * keep only entries for Epics that actually belong to this cwd, and seed the
 * per-project file with that narrowed copy. The legacy file/field is left in
 * place, untouched — this only ever reads it.
 */
async function migratePerEpic(cwd: string): Promise<Record<string, ChatVerbosity>> {
  let legacy: Record<string, unknown> = {}
  try {
    const r = await window.api.config.readJson(CHAT_PREFS_FILE)
    if (r.exists && r.data && typeof r.data === 'object') {
      legacy = (r.data as { perEpic?: Record<string, unknown> }).perEpic ?? {}
    }
  } catch { /* first run / unreadable legacy file — nothing to migrate */ }
  const knownIds = await knownEpicIdsForCwd(cwd)
  const seeded: Record<string, ChatVerbosity> = {}
  for (const [epicId, v] of Object.entries(legacy)) {
    if (!knownIds.has(epicId)) continue
    const level = readLevel(v)
    if (level) seeded[epicId] = level
  }
  // One-shot best-effort seed: nothing to revert (no user-visible optimistic
  // state was set yet), but a failure must still surface rather than vanish.
  await writeUiPrefsPatch(cwd, { chatVerbosityPerEpic: seeded }).catch((e) => {
    console.warn('migratePerEpic: failed to seed ui-prefs chatVerbosityPerEpic', e)
  })
  return seeded
}

export const useChatPrefs = create<ChatPrefsState>((set, get) => ({
  verbosity: CHAT_VERBOSITY_DEFAULT,
  perEpic: {},
  hydrated: false,
  perEpicCwd: null,

  hydrate: async (cwd) => {
    if (!get().hydrated) {
      try {
        const r = await window.api.config.readJson(CHAT_PREFS_FILE)
        if (r.exists && r.data && typeof r.data === 'object') {
          const d = r.data as Partial<PersistedChatPrefs>
          set({ verbosity: readLevel(d.verbosity) ?? CHAT_VERBOSITY_DEFAULT })
        }
      } catch { /* first run / unreadable file — fall through to defaults */ }
      set({ hydrated: true })
    }

    if (get().perEpicCwd !== cwd) {
      const prefs = await readUiPrefs(cwd)
      if (prefs.chatVerbosityPerEpic) {
        const perEpic: Record<string, ChatVerbosity> = {}
        for (const [k, v] of Object.entries(prefs.chatVerbosityPerEpic)) {
          const level = readLevel(v)
          if (level) perEpic[k] = level
        }
        set({ perEpic, perEpicCwd: cwd })
      } else {
        const seeded = await migratePerEpic(cwd)
        set({ perEpic: seeded, perEpicCwd: cwd })
      }
    }
  },

  setVerbosity: (verbosity) => {
    set({ verbosity })
    persist(get)
  },

  setEpicVerbosity: (cwd, epicId, level) => {
    const { verbosity, perEpic } = get()
    const next = { ...perEpic }
    if (level === verbosity) delete next[epicId]
    else next[epicId] = level
    set({ perEpic: next })
    writeUiPrefsPatch(cwd, { chatVerbosityPerEpic: next }).catch(() => {
      // Only revert if nothing else has moved perEpic on since this call
      // (writeUiPrefsPatch serializes per-cwd, so a later Epic's write can
      // settle and persist successfully before this one's failure is caught
      // here) — otherwise this stale failure would stomp that later,
      // already-persisted change.
      if (get().perEpic !== next) return
      set({ perEpic })
      toast.error("Couldn't save chat verbosity — reverted.")
    })
  },

  clearEpicVerbosity: (cwd, epicId) => {
    const prev = get().perEpic
    const next = { ...prev }
    delete next[epicId]
    set({ perEpic: next })
    writeUiPrefsPatch(cwd, { chatVerbosityPerEpic: next }).catch(() => {
      if (get().perEpic !== next) return
      set({ perEpic: prev })
      toast.error("Couldn't save chat verbosity — reverted.")
    })
  },
}))

/**
 * Resolve the level for one Epic. Call from a component with the two RAW
 * slices already selected — never build this inside a zustand selector (a
 * fresh object/derived value per call re-renders forever; see CLAUDE.md's
 * "Returning a freshly-built value from a zustand selector").
 */
export function resolveEpicVerbosity(
  globalLevel: ChatVerbosity,
  perEpic: Record<string, ChatVerbosity>,
  epicId: string,
): ChatVerbosity {
  return perEpic[epicId] ?? globalLevel
}
