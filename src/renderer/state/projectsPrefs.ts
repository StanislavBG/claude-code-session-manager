import { create } from 'zustand'

export type SortCol = 'project' | 'sessions' | 'last' | 'size'
export type SortDir = 'asc' | 'desc'
export type RecentFilter = 'all' | '7d' | '30d'

interface PersistedPrefs {
  pinned: Record<string, boolean>
  sort: { col: SortCol; dir: SortDir }
  recentFilter: RecentFilter
  hasRemote: boolean | null
  hasClaudemd: boolean | null
  pinnedOnly: boolean
  search: string
  editor: string
}

interface ProjectsPrefsState extends PersistedPrefs {
  hydrated: boolean
  hydrate: () => Promise<void>
  togglePin: (encoded: string) => void
  setSort: (col: SortCol) => void
  setRecentFilter: (f: RecentFilter) => void
  setHasRemote: (v: boolean | null) => void
  setHasClaudemd: (v: boolean | null) => void
  setPinnedOnly: (v: boolean) => void
  setSearch: (v: string) => void
  setEditor: (v: string) => void
}

const FILE = '~/.claude/session-manager/projects-prefs.json'

const DEFAULT_DIRS: Record<SortCol, SortDir> = {
  project: 'asc',
  sessions: 'desc',
  last: 'desc',
  size: 'desc',
}

function persist(get: () => ProjectsPrefsState): void {
  const s = get()
  const payload: PersistedPrefs = {
    pinned: s.pinned,
    sort: s.sort,
    recentFilter: s.recentFilter,
    hasRemote: s.hasRemote,
    hasClaudemd: s.hasClaudemd,
    pinnedOnly: s.pinnedOnly,
    search: s.search,
    editor: s.editor,
  }
  window.api.config.writeJson(FILE, payload).catch(() => {})
}

export const useProjectsPrefs = create<ProjectsPrefsState>((set, get) => ({
  pinned: {},
  sort: { col: 'last', dir: 'desc' },
  recentFilter: 'all',
  hasRemote: null,
  hasClaudemd: null,
  pinnedOnly: false,
  search: '',
  editor: 'auto',
  hydrated: false,

  hydrate: async () => {
    try {
      const r = await window.api.config.readJson(FILE)
      if (r.exists && r.data && typeof r.data === 'object') {
        const d = r.data as Partial<PersistedPrefs>
        set({
          pinned: d.pinned ?? {},
          sort: d.sort ?? { col: 'last', dir: 'desc' },
          recentFilter: d.recentFilter ?? 'all',
          hasRemote: d.hasRemote ?? null,
          hasClaudemd: d.hasClaudemd ?? null,
          pinnedOnly: d.pinnedOnly ?? false,
          search: d.search ?? '',
          editor: d.editor ?? 'auto',
          hydrated: true,
        })
        return
      }
    } catch {}
    set({ hydrated: true })
  },

  togglePin: (encoded) => {
    const next = { ...get().pinned, [encoded]: !get().pinned[encoded] }
    set({ pinned: next })
    persist(get)
  },

  setSort: (col) => {
    const s = get()
    const dir: SortDir =
      s.sort.col === col ? (s.sort.dir === 'asc' ? 'desc' : 'asc') : DEFAULT_DIRS[col]
    set({ sort: { col, dir } })
    persist(get)
  },

  setRecentFilter: (recentFilter) => {
    set({ recentFilter })
    persist(get)
  },

  setHasRemote: (hasRemote) => {
    set({ hasRemote })
    persist(get)
  },

  setHasClaudemd: (hasClaudemd) => {
    set({ hasClaudemd })
    persist(get)
  },

  setPinnedOnly: (pinnedOnly) => {
    set({ pinnedOnly })
    persist(get)
  },

  setSearch: (search) => {
    set({ search })
    persist(get)
  },

  setEditor: (editor) => {
    set({ editor })
    persist(get)
  },
}))
