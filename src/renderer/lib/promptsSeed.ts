/**
 * Vite eager-glob import of all seed prompt markdown files.
 *
 * import.meta.glob with { eager: true, query: '?raw' } inlines file contents
 * as strings at build time — zero runtime I/O. Each entry is parsed through
 * parsePromptMarkdown; entries that fail validation are skipped with a
 * console.error (never thrown) so a single bad file can't blank the whole tab.
 */

import { parsePromptMarkdown } from './promptFrontmatter'
import type { Prompt } from './promptFrontmatter'

// Resolved by Vite at build time. Keys are relative paths from this file's
// directory (src/renderer/lib/) to the seed files.
const raw = import.meta.glob('../../seed/prompts/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** All bundled seed prompts, parsed at module load time. */
export const seedPrompts: ReadonlyArray<Prompt> = Object.values(raw)
  .map(parsePromptMarkdown)
  .filter((p): p is Prompt => p !== null)
