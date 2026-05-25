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
 *
 * Reset trade-off (§3 of the PRD): we do NOT add a `config:delete-file` IPC
 * channel to keep this PR scoped. Instead, `resetToDefault` overwrites the
 * override with the seed body, which leaves the file on disk but makes
 * `loadEffective` return the seed content. A future `config:delete-file`
 * channel can clean this up properly.
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

/** Absolute path for the user-override file corresponding to `id`. */
export function userOverridePath(home: string, id: string): string {
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
  const seed = seedPrompts.find((p) => p.id === id)
  if (!seed) throw new Error(`[promptsStore] unknown prompt id: ${id}`)

  try {
    const home = await getHome()
    const path = userOverridePath(home, id)
    const result = await window.api.config.readText(path)
    if (result.exists && result.text) {
      const parsed = parsePromptMarkdown(result.text)
      if (parsed) return parsed
    }
  } catch {
    // Network / IPC error — fall through to seed.
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
  const seed = seedPrompts.find((p) => p.id === id)
  if (!seed) throw new Error(`[promptsStore] unknown prompt id: ${id}`)
  const home = await getHome()
  const path = userOverridePath(home, id)
  await window.api.config.writeText(path, serialize(seed, draftBody))
}

/**
 * Reset to seed default by overwriting the user override with the seed body.
 *
 * After this call, `loadEffective(id)` returns the seed content. The override
 * file still exists on disk but is semantically equivalent to the seed (the
 * Reset button hides because the bodies match). A proper delete would require
 * a `config:delete-file` IPC — deferred to a follow-up PR.
 */
export async function resetToDefault(id: string): Promise<void> {
  const seed = seedPrompts.find((p) => p.id === id)
  if (!seed) throw new Error(`[promptsStore] unknown prompt id: ${id}`)
  await saveOverride(id, seed.body)
}
