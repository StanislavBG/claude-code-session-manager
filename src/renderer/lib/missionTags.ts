import type { AgentPersona } from '../../preload/api'
import { TAG_GROUP_ORDER, type EpicTag } from './tagLibrary'

/** Missions offered when the persona declares no known `tags:` (or none selected). */
export const FALLBACK_MISSION_TAGS: EpicTag[] = ['feature', 'bug', 'discussion']

/** Missions an agent may be given: its own tags filtered to known EpicTags, else the fallback trio. */
export function missionTagsForAgent(agent: Pick<AgentPersona, 'tags'> | null | undefined): EpicTag[] {
  const known = (agent?.tags ?? []).filter((t): t is EpicTag => TAG_GROUP_ORDER.includes(t as EpicTag))
  return known.length ? known : FALLBACK_MISSION_TAGS
}
