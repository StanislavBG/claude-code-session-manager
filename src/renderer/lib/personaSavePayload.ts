/**
 * The single place a `window.api.agents.savePersona` payload is built from an existing persona.
 * `serializePersona` writes only the keys it is given, so omitting a field here makes
 * `savePersona` drop it from the `~/.claude/agents/<name>.md` file. Pure: no window.api, no state.
 */

import type { AgentPersona, AgentPersonaSaveInput, AgentPersonaTag } from '../../preload/api'
import { TAG_LIBRARY } from './tagLibrary'

// The write-side schema (agentPersonaSchema.cjs) only accepts tags from TAG_LIBRARY.
const KNOWN_PERSONA_TAGS = new Set<string>(TAG_LIBRARY.map((t) => t.tag))

export function toKnownTags(tags: string[]): AgentPersonaTag[] {
  return tags.filter((t): t is AgentPersonaTag => KNOWN_PERSONA_TAGS.has(t))
}

export function toPersonaSaveInput(
  persona: AgentPersona,
  overrides: Partial<AgentPersonaSaveInput> = {},
): AgentPersonaSaveInput {
  return {
    name: persona.name,
    originalName: persona.name,
    description: persona.description ?? '',
    tools: persona.tools,
    model: persona.model ?? 'inherit',
    effort: persona.effort ?? undefined,
    color: persona.color ?? '',
    tags: toKnownTags(persona.tags),
    projects: persona.projects,
    action: persona.action ?? undefined,
    actionLabel: persona.actionLabel ?? undefined,
    title: persona.title ?? undefined,
    body: persona.body,
    ...overrides,
  }
}
