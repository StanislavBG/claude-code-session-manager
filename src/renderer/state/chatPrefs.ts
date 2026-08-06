import { create } from 'zustand'
import { CHAT_VERBOSITY_DEFAULT, isChatVerbosity, type ChatVerbosity } from '../lib/chatVerbosity'

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
 */
interface PersistedChatPrefs {
  verbosity: ChatVerbosity
  perEpic: Record<string, ChatVerbosity>
}

interface ChatPrefsState extends PersistedChatPrefs {
  hydrated: boolean
  hydrate: () => Promise<void>
  setVerbosity: (level: ChatVerbosity) => void
  /** Passing the current global level CLEARS the override rather than pinning
   *  a redundant copy — so an Epic dialled back to the default resumes
   *  following it. */
  setEpicVerbosity: (epicId: string, level: ChatVerbosity) => void
  clearEpicVerbosity: (epicId: string) => void
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
  const payload: PersistedChatPrefs = { verbosity: s.verbosity, perEpic: s.perEpic }
  window.api.config.writeJson(CHAT_PREFS_FILE, payload).catch(() => {})
}

export const useChatPrefs = create<ChatPrefsState>((set, get) => ({
  verbosity: CHAT_VERBOSITY_DEFAULT,
  perEpic: {},
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return
    try {
      const r = await window.api.config.readJson(CHAT_PREFS_FILE)
      if (r.exists && r.data && typeof r.data === 'object') {
        const d = r.data as Partial<PersistedChatPrefs>
        const perEpic: Record<string, ChatVerbosity> = {}
        for (const [k, v] of Object.entries(d.perEpic ?? {})) {
          const level = readLevel(v)
          if (level) perEpic[k] = level
        }
        set({
          verbosity: readLevel(d.verbosity) ?? CHAT_VERBOSITY_DEFAULT,
          perEpic,
          hydrated: true,
        })
        return
      }
    } catch { /* first run / unreadable file — fall through to defaults */ }
    set({ hydrated: true })
  },

  setVerbosity: (verbosity) => {
    set({ verbosity })
    persist(get)
  },

  setEpicVerbosity: (epicId, level) => {
    const { verbosity, perEpic } = get()
    const next = { ...perEpic }
    if (level === verbosity) delete next[epicId]
    else next[epicId] = level
    set({ perEpic: next })
    persist(get)
  },

  clearEpicVerbosity: (epicId) => {
    const next = { ...get().perEpic }
    delete next[epicId]
    set({ perEpic: next })
    persist(get)
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
