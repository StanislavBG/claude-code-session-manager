/**
 * Project-scoped skill enable/disable store.
 *
 * Mirrors Unleashed's projectSkillsStore pattern but adapted to our storage
 * layout (per-project JSON file owned by the main process; no hashing).
 *
 * Semantics:
 *  - A skill not present in the persisted array is treated as `enabled: true`
 *    (default-on; project config only stores opt-outs and explicit overrides).
 *  - `isEnabled(cwd, skillId)` returns the effective value.
 *  - `setEnabled(cwd, skillId, enabled)` persists via IPC and updates the cache
 *    optimistically.
 */

import { create } from 'zustand'
import type { ProjectSkillState } from '../../preload/api'

interface ProjectSkillsState {
  /** cwd → skillId → enabled. Default-on if missing. */
  byCwd: Record<string, Record<string, boolean>>
  /** cwds currently loading. */
  loading: Record<string, boolean>

  load: (cwd: string) => Promise<void>
  setEnabled: (cwd: string, skillId: string, enabled: boolean) => Promise<void>
  isEnabled: (cwd: string, skillId: string) => boolean
  getMap: (cwd: string) => Record<string, boolean>
}

function toMap(states: ProjectSkillState[]): Record<string, boolean> {
  const m: Record<string, boolean> = {}
  for (const s of states) m[s.skillId] = s.enabled
  return m
}

export const useProjectSkills = create<ProjectSkillsState>((set, get) => ({
  byCwd: {},
  loading: {},

  load: async (cwd) => {
    if (!cwd) return
    if (get().loading[cwd]) return
    set((s) => ({ loading: { ...s.loading, [cwd]: true } }))
    try {
      const states = await window.api.projectSkills.get(cwd)
      set((s) => ({
        byCwd: { ...s.byCwd, [cwd]: toMap(states) },
        loading: { ...s.loading, [cwd]: false },
      }))
    } catch {
      set((s) => ({ loading: { ...s.loading, [cwd]: false } }))
    }
  },

  setEnabled: async (cwd, skillId, enabled) => {
    if (!cwd || !skillId) return
    // Optimistic update.
    const prev = get().byCwd[cwd] ?? {}
    set((s) => ({
      byCwd: { ...s.byCwd, [cwd]: { ...prev, [skillId]: enabled } },
    }))
    try {
      await window.api.projectSkills.set(cwd, skillId, enabled)
    } catch {
      // Roll back on failure.
      set((s) => ({ byCwd: { ...s.byCwd, [cwd]: prev } }))
    }
  },

  isEnabled: (cwd, skillId) => {
    const m = get().byCwd[cwd]
    if (!m) return true
    // Default-on: absence means enabled.
    return m[skillId] !== false
  },

  getMap: (cwd) => get().byCwd[cwd] ?? {},
}))
