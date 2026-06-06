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
  home: string | null
  /** Idempotent — loads the sidecar once per home dir. */
  load: (home: string) => Promise<void>
  /** Set (or clear, with null) an override and persist. */
  setOverride: (key: string, value: Provenance | null) => Promise<void>
}

export const useProvenance = create<ProvenanceState>((set, get) => ({
  overrides: {},
  loaded: false,
  home: null,
  load: async (home) => {
    if (get().home === home && get().loaded) return
    set({ home })
    try {
      const res = await window.api.config.readJson(sidecarPath(home))
      set({ overrides: res.exists ? sanitize(res.data) : {}, loaded: true })
    } catch {
      set({ overrides: {}, loaded: true })
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
