/**
 * hives — zustand store for pre-baked subagent swarm templates.
 *
 * Merges three sources in `list`:
 *   1. DEFAULT_HIVES (renderer-only starters, slug prefix `default:`)
 *   2. User-saved hives from IPC (`~/.claude/session-manager/hives/*.json`)
 *
 * Defaults sort first, alphabetized; user hives follow.
 *
 * Mutations (save / delete / edit) only touch user hives. Defaults are
 * recognized via `isDefaultHive(slug)` and treated as read-only — the manager
 * UI offers a "clone" path that copies the default into a new user hive.
 */

import { create } from 'zustand'
import type { Recipe } from '../../preload/api'
import { DEFAULT_HIVES, isDefaultHive } from '../lib/defaultHives'
import { toast } from './toast'
import { log } from '../lib/logger'

interface HivesState {
  /** All hives currently surfaced, defaults first then user hives, alphabetized. */
  list: Recipe[]
  /** Slug of the hive currently selected in HiveManagerModal, or null. */
  selectedSlug: string | null
  /** True while the initial load IPC is in flight. */
  loading: boolean
  /** Last IPC error message, surfaced inline in the modal. */
  error: string | null

  load: () => Promise<void>
  select: (slug: string | null) => void
  /** Update a user hive's fields locally without saving — call save() to persist. */
  edit: (slug: string, patch: Partial<Omit<Recipe, 'slug'>>) => void
  /** Persist one hive. Replaces any existing user hive with the same slug.
   *  Refuses to save default-prefixed slugs. */
  save: (hive: Recipe) => Promise<{ ok: boolean; error?: string }>
  /** Delete one user hive. Refuses to delete defaults. */
  delete: (slug: string) => Promise<{ ok: boolean; error?: string }>
}

/** Merge defaults + user recipes. Defaults first (alphabetized), then user
 *  (alphabetized). O(n log n) where n is total recipe count. */
function mergeRecipes(userRecipes: Recipe[]): Recipe[] {
  const defaults = [...DEFAULT_HIVES].sort((a, b) => a.name.localeCompare(b.name))
  const users = userRecipes
    .filter((h) => !isDefaultHive(h.slug))
    .sort((a, b) => a.name.localeCompare(b.name))
  return [...defaults, ...users]
}

/** Deduped list of agentNames referenced by a recipe's steps. */
export function referencedAgentNames(recipe: Recipe): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const step of recipe.steps) {
    if (!seen.has(step.agentName)) {
      seen.add(step.agentName)
      result.push(step.agentName)
    }
  }
  return result
}

export const useHives = create<HivesState>((set, get) => ({
  list: mergeRecipes([]),
  selectedSlug: null,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null })
    try {
      const res = await window.api.hives.list()
      if (res.error) {
        log.warn('hives', 'hives:list returned error', { error: res.error })
        set({ list: mergeRecipes([]), loading: false, error: res.error })
        toast.error(`Hives: failed to load (${res.error})`)
        return
      }
      set({ list: mergeRecipes(res.hives), loading: false, error: null })
    } catch (e) {
      const msg = (e as Error).message
      log.error('hives', 'hives:list threw', { error: msg })
      set({ list: mergeRecipes([]), loading: false, error: msg })
      toast.error(`Hives: ${msg}`)
    }
  },

  select: (slug) => set({ selectedSlug: slug }),

  edit: (slug, patch) => {
    if (isDefaultHive(slug)) return
    const state = get()
    const idx = state.list.findIndex((h) => h.slug === slug)
    if (idx === -1) return
    const next = state.list.slice()
    next[idx] = { ...next[idx], ...patch, slug } // slug never changes via edit
    set({ list: next })
  },

  save: async (hive) => {
    if (isDefaultHive(hive.slug)) {
      const err = 'cannot save a default hive — clone it first'
      toast.warn(err)
      return { ok: false, error: err }
    }
    try {
      const res = await window.api.hives.save(hive.slug, hive)
      if (!res.ok) {
        toast.error(`Hives: save failed — ${res.error ?? 'unknown'}`)
        return { ok: false, error: res.error ?? 'save failed' }
      }
      // Refresh local list. Cheap — full list is tiny.
      await get().load()
      return { ok: true }
    } catch (e) {
      const msg = (e as Error).message
      toast.error(`Hives: ${msg}`)
      return { ok: false, error: msg }
    }
  },

  delete: async (slug) => {
    if (isDefaultHive(slug)) {
      const err = 'cannot delete a default hive'
      toast.warn(err)
      return { ok: false, error: err }
    }
    try {
      const res = await window.api.hives.delete(slug)
      if (!res.ok) {
        toast.error(`Hives: delete failed — ${res.error ?? 'unknown'}`)
        return { ok: false, error: res.error ?? 'delete failed' }
      }
      const state = get()
      const nextSelected = state.selectedSlug === slug ? null : state.selectedSlug
      set({
        list: state.list.filter((h) => h.slug !== slug),
        selectedSlug: nextSelected,
      })
      return { ok: true }
    } catch (e) {
      const msg = (e as Error).message
      toast.error(`Hives: ${msg}`)
      return { ok: false, error: msg }
    }
  },
}))

/** Generate a fresh user-hive slug. Lowercase alphanumeric + dash, capped at
 *  the SLUG_RE length cap (64). */
export function generateHiveSlug(seed = 'hive'): string {
  const base = seed
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
  const rand = Math.random().toString(36).slice(2, 8)
  const candidate = `${base || 'hive'}-${rand}`
  return candidate.slice(0, 64)
}
