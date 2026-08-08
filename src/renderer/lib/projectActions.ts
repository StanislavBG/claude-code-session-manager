/**
 * projectActions — resolves which Agent Library personas surface as one-click
 * **Action buttons** in a given project's Sessions toolbar.
 *
 * An Action is not a fourth concept alongside Agent/Tag/Session: it is an
 * Agent persona that has been given a *project scope*. Pressing it opens a
 * brand-new Session grounded by the same AIM framework every other Session
 * uses (`lib/epicIntake.ts`'s `composeEpicIntake`) — the persona supplies the
 * **Actor**, its mission tag supplies the **Mission**, and the persona's own
 * `action:` frontmatter line supplies the opening goal. The button is a
 * shortcut around the New Session card, never a second creation path.
 *
 * The scoping axis lives on the persona file itself (`projects:` in
 * `~/.claude/agents/<name>.md`, written by `agentLibrary.cjs`), so "which
 * project does this Action appear in" is editable from Agent Library with no
 * parallel registry to drift against.
 */

import type { AgentPersona } from '../../preload/api'
import { normalizeCwd } from './knownProjectAggregate'
import { TAG_LIBRARY, type EpicTag } from './tagLibrary'

/** `projects:` entry meaning "every project" — mirrors agentLibrary.cjs's ALL_PROJECTS. */
export const ALL_PROJECTS = '*'

export interface ProjectAction {
  /** Persona name — the Session's `agentType` (the AIM Actor). */
  agentName: string
  agentDescription: string | null
  /** Button caption: `actionLabel` if set, else the persona name. */
  label: string
  /** Opening instruction sent into the new Session. Never empty. */
  action: string
  /** The Session's mission tag — the persona's first valid tag, else 'discussion'. */
  tag: EpicTag
  /** Whether this persona is scoped to this one project or to every project. */
  scope: 'project' | 'all'
  /** Hover text explaining what pressing the button will do. */
  tooltip: string
}

const VALID_TAGS = new Set<string>(TAG_LIBRARY.map((t) => t.tag))

/** The persona's mission tag for an Action-spawned Session. A persona may carry
 *  several tags (the Agent<->Tag relationship is many-to-many); the first one in
 *  TAG_LIBRARY order wins so the choice is stable rather than file-order
 *  dependent. A persona with no tag at all still gets a Session — 'discussion'
 *  is the tag that never assumes /develop should fire. */
export function actionTag(persona: Pick<AgentPersona, 'tags'>): EpicTag {
  for (const entry of TAG_LIBRARY) {
    if (persona.tags?.includes(entry.tag)) return entry.tag
  }
  return 'discussion'
}

/**
 * Resolves one persona into an Action, or null when it isn't one for `cwd`.
 * Exported for the Agent Library editor, which previews the same resolution
 * (including the description fallback) while the user is still typing.
 */
export function resolveProjectAction(persona: AgentPersona, cwd: string): ProjectAction | null {
  const target = normalizeCwd(cwd)
  if (!target) return null
  const scopes = persona.projects ?? []
  const all = scopes.includes(ALL_PROJECTS)
  if (!all && !scopes.some((p) => normalizeCwd(p) === target)) return null

  // An Action without an instruction would open a session with nothing to do.
  // Rather than silently dropping a persona the user deliberately scoped, fall
  // back to its own description — the shortest honest statement of intent it
  // already carries. Only a persona with neither is skipped.
  const instruction = (persona.action ?? '').trim() || (persona.description ?? '').trim()
  if (!instruction) return null

  const label = (persona.actionLabel ?? '').trim() || persona.name
  const tag = actionTag(persona)
  return {
    agentName: persona.name,
    agentDescription: persona.description,
    label,
    action: instruction,
    tag,
    scope: all ? 'all' : 'project',
    tooltip: `Start a new ${tag} session as "${persona.name}": ${instruction.split('\n')[0]}`,
  }
}

/**
 * Every Action button to render for `cwd`, in a stable case-insensitive label
 * order (persona files are read in filename order, which is not the order a
 * human reads buttons in).
 *
 * Complexity: O(n log n) in the persona count.
 */
export function projectActions(personas: readonly AgentPersona[], cwd: string | null | undefined): ProjectAction[] {
  if (!cwd) return []
  const out: ProjectAction[] = []
  for (const p of personas) {
    const a = resolveProjectAction(p, cwd)
    if (a) out.push(a)
  }
  return out.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()))
}

/** True when `tag` is one this app knows — used by the Agent Library editor to
 *  warn about a hand-edited persona file carrying an unknown tag. */
export function isKnownTag(tag: string): boolean {
  return VALID_TAGS.has(tag)
}
