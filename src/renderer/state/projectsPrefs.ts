import { create } from 'zustand'
import { toast } from './toast'

interface ProjectsPrefsState {
  /** Keyed by the project's cwd — a project IS its working directory. */
  pinned: Record<string, boolean>
  hydrated: boolean
  hydrate: () => Promise<void>
  togglePin: (cwd: string) => void
}

const FILE = '~/.claude/session-manager/projects-prefs.json'

// Every read-modify-write funnels through this queue so two quick toggles
// cannot interleave and drop each other's change (same shape as
// lib/uiSettingsPrefs.ts's writeUiSettingsPrefs).
let queue: Promise<void> = Promise.resolve()
let hydratePromise: Promise<void> | null = null

function enqueue(task: () => Promise<void>): Promise<void> {
  const run = queue.then(task)
  queue = run.catch(() => {})
  return run
}

/** Reads the file fresh; a missing file is an empty pin set, any other failure rejects. */
async function readPinned(): Promise<Record<string, boolean>> {
  const r = await window.api.config.readJson(FILE)
  if (r.exists && r.data && typeof r.data === 'object') {
    const p = (r.data as { pinned?: unknown }).pinned
    if (p && typeof p === 'object') return { ...(p as Record<string, boolean>) }
  }
  return {}
}

/** Resolves once every queued pin read/write has settled. */
export function __flushProjectsPrefsForTests(): Promise<void> {
  return queue
}

/** Forgets the in-flight/finished hydrate so a test can hydrate afresh. */
export function __resetProjectsPrefsHydrateForTests(): void {
  hydratePromise = null
}

export const useProjectsPrefs = create<ProjectsPrefsState>((set) => ({
  pinned: {},
  hydrated: false,

  hydrate: () => {
    if (hydratePromise) return hydratePromise
    hydratePromise = enqueue(async () => {
      try {
        set({ pinned: await readPinned(), hydrated: true })
      } catch (err) {
        console.warn('projectsPrefs: could not read launcher pins', err)
        set({ hydrated: true })
      }
    })
    return hydratePromise
  },

  togglePin: (cwd) => {
    void enqueue(async () => {
      let lastRead: Record<string, boolean>
      try {
        lastRead = await readPinned()
      } catch (err) {
        console.warn('projectsPrefs: could not read launcher pins', err)
        toast.error('Could not update pinned projects: the preferences file is unreadable.')
        return
      }
      const next = { ...lastRead }
      if (next[cwd]) delete next[cwd]
      else next[cwd] = true
      try {
        await window.api.config.writeJson(FILE, { pinned: next })
        set({ pinned: next })
      } catch (err) {
        set({ pinned: lastRead })
        toast.error(`Could not save pinned projects: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  },
}))
