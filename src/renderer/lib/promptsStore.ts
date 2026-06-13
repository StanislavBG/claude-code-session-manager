/**
 * User-override store for the Prompts tab.
 *
 * User overrides live at:
 *   ~/.claude/session-manager/prompts/<category>/<slug>.md
 *
 * The `id` field already embeds the category prefix (e.g.
 * "security/owasp-top-10-staged-diff"), so the path resolves naturally.
 *
 * Override precedence: if the override file exists AND successfully parses,
 * it shadows the seed. Otherwise the seed is returned.
 */

import { seedPrompts } from './promptsSeed'
import { parsePromptMarkdown } from './promptFrontmatter'
import type { Prompt } from './promptFrontmatter'

// Cached home dir — fetched once, then stable for the app lifetime.
let cachedHome: string | null = null

async function getHome(): Promise<string> {
  if (cachedHome) return cachedHome
  cachedHome = await window.api.app.homeDir()
  return cachedHome
}

function mustFindSeed(id: string): Prompt {
  const seed = seedPrompts.find((p) => p.id === id)
  if (!seed) throw new Error(`[promptsStore] unknown prompt id: ${id}`)
  return seed
}

/** Absolute path for the user-override file corresponding to `id`. */
export function userOverridePath(home: string, id: string): string {
  // Ids come from seed frontmatter and are interpolated into a filesystem
  // path — constrain to "category/slug" so a hostile id can't traverse.
  if (!/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    throw new Error(`invalid prompt id: ${id}`)
  }
  return `${home}/.claude/session-manager/prompts/${id}.md`
}

/** Serialize a Prompt back to markdown (frontmatter from seed + caller-supplied body). */
function serialize(base: Prompt, body: string): string {
  return [
    '---',
    `id: ${base.id}`,
    `title: ${base.title}`,
    `category: ${base.category}`,
    `sendMode: ${base.sendMode}`,
    `description: ${base.description}`,
    '---',
    body,
  ].join('\n')
}

/**
 * Load the effective prompt for `id`.
 *
 * Tries the user-override file first; falls back to the seed on any error.
 */
export async function loadEffective(id: string): Promise<Prompt> {
  const seed = mustFindSeed(id)

  try {
    const home = await getHome()
    const result = await window.api.config.readText(userOverridePath(home, id))
    if (result.exists && result.text) {
      const parsed = parsePromptMarkdown(result.text)
      if (parsed) return parsed
    }
  } catch {
    // IPC error — fall through to seed.
  }

  return seed
}

/**
 * Save a user override for `id` with the given body.
 *
 * Frontmatter is taken from the seed so only the body changes. config.writeText
 * performs an atomic tmp-rename on the main-process side.
 */
export async function saveOverride(id: string, draftBody: string): Promise<void> {
  const seed = mustFindSeed(id)
  const home = await getHome()
  await window.api.config.writeText(userOverridePath(home, id), serialize(seed, draftBody))
}

/**
 * Reset to seed default by deleting the user-override file (to trash, via
 * files:delete). If the override exists but the delete fails, fall back to
 * overwriting it with the seed body — semantically equivalent, file stays on
 * disk. If the override is already gone there is nothing to do (the old
 * unconditional fallback re-created a fresh override file on a failed delete
 * of a nonexistent path).
 */
export async function resetToDefault(id: string): Promise<void> {
  const seed = mustFindSeed(id)
  const home = await getHome()
  const path = userOverridePath(home, id)
  const existing = await window.api.config.readText(path)
  if (!existing.exists) return // no override on disk — already at default
  const result = await window.api.files.delete(path)
  if (!result.ok) await saveOverride(id, seed.body)
}
