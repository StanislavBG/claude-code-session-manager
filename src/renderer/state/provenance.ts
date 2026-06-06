/**
 * Per-item provenance OVERRIDES — the manual correction layer over the
 * heuristic classifier in lib/provenance.ts. Persisted as a flat
 * { "<key>": "anthropic" | "community" | "local" } map in the sidecar
 * ~/.claude/session-manager/provenance.json (atomic write via config.writeJson).
 *
 * The classifier is the default; an entry here wins when present. Clearing an
 * override deletes the key, reverting that item to auto-detection.
 */
import { create } from 'zustand'
import type { Provenance } from '../lib/provenance'

const sidecarPath = (home: string) => `${home}/.claude/session-manager/provenance.json`

function sanitize(data: unknown): Record<string, Provenance> {
  if (!data || typeof data !== 'object') return {}
  const out: Record<string, Provenance> = {}
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (v === 'anthropic' || v === 'community' || v === 'local') out[k] = v
  }
  return out
}

interface ProvenanceState {
  overrides: Record<string, Provenance>
  loaded: boolean
  loading: boolean
  home: string | null
  /** Idempotent — loads the sidecar once per home dir (deduped across the many
   *  badges that mount at once). */
  load: (home: string) => Promise<void>
  /** Set (or clear, with null) an override and persist. */
  setOverride: (key: string, value: Provenance | null) => Promise<void>
}

export const useProvenance = create<ProvenanceState>((set, get) => ({
  overrides: {},
  loaded: false,
  loading: false,
  home: null,
  load: async (home) => {
    const s = get()
    if (s.home === home && (s.loaded || s.loading)) return
    set({ home, loading: true })
    try {
      const res = await window.api.config.readJson(sidecarPath(home))
      const fileMap = res.exists ? sanitize(res.data) : {}
      // In-memory overrides win over the file: a setOverride that landed while
      // the read was in flight must not be clobbered by stale file contents.
      set((cur) => ({ overrides: { ...fileMap, ...cur.overrides }, loaded: true, loading: false }))
    } catch {
      set({ loaded: true, loading: false })
    }
  },
  setOverride: async (key, value) => {
    const next = { ...get().overrides }
    if (value === null) delete next[key]
    else next[key] = value
    set({ overrides: next })
    const home = get().home
    if (!home) return
    try {
      await window.api.config.writeJson(sidecarPath(home), next)
    } catch {
      /* non-fatal: the in-memory override still applies this session */
    }
  },
}))
