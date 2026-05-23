/**
 * agentMemory.ts — zustand store for per-subagent memory.
 *
 * Mirrors Unleashed's agentMemoryStore but keyed by agentId (subagent name)
 * instead of projectPath. Backed by ~/.claude/session-manager/agent-memory/.
 *
 * Memory model:
 *   - One Map<agentId, AgentMemoryEntry[]> as the in-memory cache.
 *   - Loaders/mutators round-trip through window.api.agentMemory.* — the IPC
 *     layer is the source of truth, this store is just a cache so list+detail
 *     navigation doesn't refire IPC on every keystroke.
 *   - The Map is replaced on every mutation so React + zustand shallow-equals
 *     see the change (Map references are otherwise stable).
 */

import { create } from 'zustand'
import type { AgentMemoryEntry, AgentMemoryCategory } from '../../preload/api'

interface AgentMemoryState {
  /** agentId -> entries (newest first). */
  entriesByAgent: Map<string, AgentMemoryEntry[]>
  /** agentId currently loading (so the UI can show a spinner). */
  loading: string | null
  /** Last error message per agent (cleared on next successful load). */
  errorByAgent: Map<string, string>

  loadAgent: (agentId: string) => Promise<void>
  setEntry: (agentId: string, entryId: string, body: string, category?: AgentMemoryCategory) => Promise<{ ok: boolean; error: string | null }>
  deleteEntry: (agentId: string, entryId: string) => Promise<{ ok: boolean; error: string | null }>
}

export const useAgentMemory = create<AgentMemoryState>((set, get) => ({
  entriesByAgent: new Map(),
  loading: null,
  errorByAgent: new Map(),

  loadAgent: async (agentId: string) => {
    set({ loading: agentId })
    const r = await window.api.agentMemory.list(agentId)
    const next = new Map(get().entriesByAgent)
    next.set(agentId, r.entries)
    const errs = new Map(get().errorByAgent)
    if (r.error) errs.set(agentId, r.error)
    else errs.delete(agentId)
    set({ entriesByAgent: next, loading: null, errorByAgent: errs })
  },

  setEntry: async (agentId, entryId, body, category) => {
    const r = await window.api.agentMemory.set(agentId, entryId, body, category)
    if (r.ok) await get().loadAgent(agentId)
    return r
  },

  deleteEntry: async (agentId, entryId) => {
    const r = await window.api.agentMemory.delete(agentId, entryId)
    if (r.ok) {
      // Optimistic local removal so the UI doesn't flash an extra IPC round-trip.
      const next = new Map(get().entriesByAgent)
      const cur = next.get(agentId) ?? []
      next.set(agentId, cur.filter((e) => e.id !== entryId))
      set({ entriesByAgent: next })
    }
    return r
  },
}))
