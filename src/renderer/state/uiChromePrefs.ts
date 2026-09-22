import { create } from 'zustand'

/**
 * Persisted renderer-only chrome/navigation prefs — sidebar width/collapse,
 * nav-group fold state, learning-panel collapse, tour completion, density.
 * Follows the `epicsPrefs.ts` pattern: zustand store + tmp+rename JSON file
 * via `window.api.config.writeJson`, hydrated once on mount.
 */
export type Density = 'compact' | 'roomy'

interface PersistedUiChromePrefs {
  sidebarWidth: number
  sidebarCollapsed: boolean
  collapsedGroups: string[]
  learningPanelCollapsed: boolean
  tourCompletedAt: number | null
  density: Density
}

interface UiChromePrefsState extends PersistedUiChromePrefs {
  hydrated: boolean
  hydrate: () => Promise<void>
  setSidebarWidth: (width: number) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setCollapsedGroups: (groups: string[]) => void
  setLearningPanelCollapsed: (collapsed: boolean) => void
  setTourCompletedAt: (ts: number | null) => void
  setDensity: (density: Density) => void
}

const FILE = '~/.claude/session-manager/ui-chrome-prefs.json'

export const SIDEBAR_WIDTH_MIN = 180
export const SIDEBAR_WIDTH_MAX = 480
export const SIDEBAR_WIDTH_DEFAULT = 252

const DEFAULTS: PersistedUiChromePrefs = {
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  sidebarCollapsed: false,
  collapsedGroups: [],
  learningPanelCollapsed: false,
  tourCompletedAt: null,
  density: 'roomy',
}

export function clampWidth(v: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, v))
}

// Every consumer (AlmanacSidebar, LearningPanel, useDensity, hasCompletedTour)
// calls hydrate() independently on mount; sharing one in-flight promise
// collapses those into a single readJson() round trip instead of N racing
// reads, and lets a caller that needs the resolved value (hasCompletedTour)
// `await` the same read everyone else triggered.
let hydratePromise: Promise<void> | null = null

// A setter can fire before that in-flight read resolves (e.g. a user
// interacts within the same tick as boot). Track which fields were touched
// pre-hydration so hydrate()'s disk-derived values never clobber them —
// the in-memory change always wins over whatever was on disk for that field.
let pendingOverrides: Partial<PersistedUiChromePrefs> = {}

function persist(get: () => UiChromePrefsState): void {
  const write = () => {
    const s = get()
    const payload: PersistedUiChromePrefs = {
      sidebarWidth: s.sidebarWidth,
      sidebarCollapsed: s.sidebarCollapsed,
      collapsedGroups: s.collapsedGroups,
      learningPanelCollapsed: s.learningPanelCollapsed,
      tourCompletedAt: s.tourCompletedAt,
      density: s.density,
    }
    window.api.config.writeJson(FILE, payload).catch(() => {})
  }
  // Defer the write until the in-flight hydrate() read resolves so it
  // persists the full merged state (disk values + this change) instead of
  // clobbering not-yet-loaded fields with in-memory defaults.
  if (get().hydrated || !hydratePromise) write()
  else hydratePromise.then(write)
}

function setAndPersist<K extends keyof PersistedUiChromePrefs>(
  set: (patch: Partial<UiChromePrefsState>) => void,
  get: () => UiChromePrefsState,
  patch: Pick<PersistedUiChromePrefs, K>,
): void {
  set(patch)
  // Only worth tracking as an override while a hydrate() read is actually
  // in flight — if hydrate() was never called (or already resolved), there
  // is no pending disk snapshot for this field to be clobbered by.
  if (!get().hydrated && hydratePromise) Object.assign(pendingOverrides, patch)
  persist(get)
}

export const useUiChromePrefs = create<UiChromePrefsState>((set, get) => ({
  ...DEFAULTS,
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return Promise.resolve()
    if (hydratePromise) return hydratePromise
    hydratePromise = (async () => {
      try {
        const r = await window.api.config.readJson(FILE)
        if (r.exists && r.data && typeof r.data === 'object') {
          const d = r.data as Partial<PersistedUiChromePrefs>
          set({
            sidebarWidth: typeof d.sidebarWidth === 'number' ? clampWidth(d.sidebarWidth) : DEFAULTS.sidebarWidth,
            sidebarCollapsed: d.sidebarCollapsed ?? DEFAULTS.sidebarCollapsed,
            collapsedGroups: Array.isArray(d.collapsedGroups) ? d.collapsedGroups : DEFAULTS.collapsedGroups,
            learningPanelCollapsed: d.learningPanelCollapsed ?? DEFAULTS.learningPanelCollapsed,
            tourCompletedAt: typeof d.tourCompletedAt === 'number' ? d.tourCompletedAt : DEFAULTS.tourCompletedAt,
            density: d.density === 'compact' ? 'compact' : DEFAULTS.density,
            // Anything set locally while this read was in flight wins over
            // the disk snapshot for that field.
            ...pendingOverrides,
            hydrated: true,
          })
          return
        }
      } catch {}
      set({ ...pendingOverrides, hydrated: true })
    })().finally(() => {
      hydratePromise = null
      pendingOverrides = {}
    })
    return hydratePromise
  },

  setSidebarWidth: (width) => setAndPersist(set, get, { sidebarWidth: clampWidth(width) }),
  setSidebarCollapsed: (collapsed) => setAndPersist(set, get, { sidebarCollapsed: collapsed }),
  setCollapsedGroups: (groups) => setAndPersist(set, get, { collapsedGroups: groups }),
  setLearningPanelCollapsed: (collapsed) => setAndPersist(set, get, { learningPanelCollapsed: collapsed }),
  setTourCompletedAt: (ts) => setAndPersist(set, get, { tourCompletedAt: ts }),
  setDensity: (density) => setAndPersist(set, get, { density }),
}))
