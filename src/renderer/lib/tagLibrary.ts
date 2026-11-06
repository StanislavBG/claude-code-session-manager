/**
 * Single source of truth for the Epic intent-tag taxonomy — the same
 * `'feature' | 'bug' | 'discussion' | 'build'` union tracked by
 * `state/promptSessions.ts` (`PromptSession['tag']`) and
 * `lib/ticketDisplay.ts` (`TicketTag`). Descriptions quote this project's own
 * CLAUDE.md "Domain model (TAB / EPIC)" section verbatim. `ticketDisplay.ts`
 * (tone/color) and `epicQueueControls.ts` (group order) both import the tag
 * list from here rather than keeping their own copies.
 */
export type EpicTag = 'feature' | 'bug' | 'discussion' | 'build' | 'project-home-builder' | 'art' | 'portfolio'

export type DevelopEagerness = 'expected-default' | 'available-not-assumed'

export interface TagLibraryEntry {
  tag: EpicTag
  label: string
  description: string
  developEagerness: DevelopEagerness
  /**
   * Which skill/protocol actually fires for this tag — `developEagerness`
   * only says how eagerly, not which mechanism. Only `feature`/`bug`/
   * `discussion`/`art` route through the `session-manager-dev:develop` skill
   * itself; `portfolio` routes via send-feedback; the others each name a dedicated,
   * different skill/protocol and never decompose via /develop's own PRD pipeline (project-home-builder
   * falls back to /develop only as a one-time bootstrap if its own pipeline
   * doesn't exist yet — see agentTagDefs.ts's template for that tag).
   */
  developsVia: string
  /**
   * True when the Mission's opening template instructs queuing via /develop, so
   * it contradicts a session started with the develop loop off.
   */
  requiresDevelopLoop: boolean
}

export const TAG_LIBRARY: TagLibraryEntry[] = [
  {
    tag: 'feature',
    label: 'Feature',
    description:
      'The tag also sets how eagerly /develop should fire inside that Epic\'s session — see the session-manager-dev:develop skill\'s "Tag-aware default": feature/bug treat PRD decomposition as the expected next step.',
    developEagerness: 'expected-default',
    developsVia: '/develop',
    requiresDevelopLoop: true,
  },
  {
    tag: 'bug',
    label: 'Bug',
    description:
      'The tag also sets how eagerly /develop should fire inside that Epic\'s session — see the session-manager-dev:develop skill\'s "Tag-aware default": feature/bug treat PRD decomposition as the expected next step.',
    developEagerness: 'expected-default',
    developsVia: '/develop',
    requiresDevelopLoop: true,
  },
  {
    tag: 'discussion',
    label: 'Discussion',
    description:
      'discussion keeps /develop available but never assumed until whether-to-build is actually settled.',
    developEagerness: 'available-not-assumed',
    developsVia: '/develop',
    requiresDevelopLoop: false,
  },
  {
    tag: 'build',
    label: 'Build',
    description:
      "A build Epic's whole point is to run the Builder skill — decomposition into PRDs (or a direct build run) is the expected next step, the same as feature/bug.",
    developEagerness: 'expected-default',
    developsVia: '/builder (not /develop)',
    requiresDevelopLoop: false,
  },
  {
    tag: 'project-home-builder',
    label: 'Project Home Builder',
    description:
      'Reads a project and writes Knowledge Pages for its Project Home via the project-home-builder local agent and the project_page_write tool (project_home_write for the Overview). Decomposition into PRDs is the expected next step, same as feature/bug/build.',
    developEagerness: 'expected-default',
    developsVia: 'project-home-builder agent protocol (not /develop)',
    requiresDevelopLoop: false,
  },
  {
    tag: 'art',
    label: '3D art / animation',
    description:
      'Blender modeling, rigging, skinning and animation work whose source of truth is a .blend file. Decomposition into PRDs executed by an art persona is the expected next step, same as feature/bug.',
    developEagerness: 'expected-default',
    developsVia: '/develop (PRDs executed by an art persona, e.g. agentType blender-artist)',
    requiresDevelopLoop: true,
  },
  {
    tag: 'portfolio',
    label: 'Portfolio Optimization',
    description:
      "A cross-project review of the owner's whole portfolio (money, influence, online presence) that judges past decisions and routes at most a few changes to the projects that own them. Like discussion it never decomposes into PRDs here; decided changes leave via send-feedback (feedback_open_session) as proposed Epics in the owning project.",
    developEagerness: 'available-not-assumed',
    developsVia: 'send-feedback / feedback_open_session to the owning project (never /develop here)',
    requiresDevelopLoop: false,
  },
]

export const TAG_GROUP_ORDER: ReadonlyArray<EpicTag> = TAG_LIBRARY.map((entry) => entry.tag)

export function tagLibraryEntry(tag: EpicTag): TagLibraryEntry {
  const found = TAG_LIBRARY.find((entry) => entry.tag === tag)
  if (!found) throw new Error(`unknown tag: ${tag}`)
  return found
}

/** A missing tag is how an Epic records No mission — it is NOT an eighth EpicTag. */
export const NO_MISSION = {
  label: 'None',
  description: 'No mission — your goal is sent as written, with no task framing.',
} as const

export function missionLabel(tag: EpicTag | null | undefined): string {
  return tag ? tagLibraryEntry(tag).label : NO_MISSION.label
}
