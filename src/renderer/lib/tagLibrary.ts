/**
 * Single source of truth for the Epic intent-tag taxonomy — the same
 * `'feature' | 'bug' | 'discussion' | 'build'` union tracked by
 * `state/promptSessions.ts` (`PromptSession['tag']`) and
 * `lib/ticketDisplay.ts` (`TicketTag`). Descriptions quote this project's own
 * CLAUDE.md "Domain model (TAB / EPIC)" section verbatim. `ticketDisplay.ts`
 * (tone/color) and `epicQueueControls.ts` (group order) both import the tag
 * list from here rather than keeping their own copies.
 */
export type EpicTag = 'feature' | 'bug' | 'discussion' | 'build' | 'project-home-builder' | 'bilko-host-publisher'

export type DevelopEagerness = 'expected-default' | 'available-not-assumed'

export interface TagLibraryEntry {
  tag: EpicTag
  label: string
  description: string
  developEagerness: DevelopEagerness
  /**
   * Which skill/protocol actually fires for this tag — `developEagerness`
   * only says how eagerly, not which mechanism. Only `feature`/`bug`/
   * `discussion` route through the `session-manager-dev:develop` skill
   * itself; the other three each name a dedicated, different skill/protocol
   * and never decompose via /develop's own PRD pipeline (project-home-builder
   * falls back to /develop only as a one-time bootstrap if its own pipeline
   * doesn't exist yet — see agentTagDefs.ts's template for that tag).
   */
  developsVia: string
}

export const TAG_LIBRARY: TagLibraryEntry[] = [
  {
    tag: 'feature',
    label: 'Feature',
    description:
      'The tag also sets how eagerly /develop should fire inside that Epic\'s session — see the session-manager-dev:develop skill\'s "Tag-aware default": feature/bug treat PRD decomposition as the expected next step.',
    developEagerness: 'expected-default',
    developsVia: '/develop',
  },
  {
    tag: 'bug',
    label: 'Bug',
    description:
      'The tag also sets how eagerly /develop should fire inside that Epic\'s session — see the session-manager-dev:develop skill\'s "Tag-aware default": feature/bug treat PRD decomposition as the expected next step.',
    developEagerness: 'expected-default',
    developsVia: '/develop',
  },
  {
    tag: 'discussion',
    label: 'Discussion',
    description:
      'discussion keeps /develop available but never assumed until whether-to-build is actually settled.',
    developEagerness: 'available-not-assumed',
    developsVia: '/develop',
  },
  {
    tag: 'build',
    label: 'Build',
    description:
      "A build Epic's whole point is to run the Builder skill — decomposition into PRDs (or a direct build run) is the expected next step, the same as feature/bug.",
    developEagerness: 'expected-default',
    developsVia: '/builder (not /develop)',
  },
  {
    tag: 'project-home-builder',
    label: 'Project Home Builder',
    description:
      'Generates a project\'s 5 static Project Page HTML files (home, marketing, feature, architecture, brief) via the project-home-builder local agent — see session-manager-operations/architecture/project-pages-pipeline.md. Decomposition into PRDs is the expected next step, same as feature/bug/build.',
    developEagerness: 'expected-default',
    developsVia: 'project-home-builder agent protocol (falls back to /develop only if that pipeline doesn\'t exist yet)',
  },
  {
    tag: 'bilko-host-publisher',
    label: 'Bilko Host Publisher',
    description:
      'Publishes this project\'s generated Marketing Project Page to bilko.run via the bilko-host MCP\'s gated static-path publish pipeline — see session-manager-operations/architecture/bilko-host-integration.md. Running the publish sequence is the expected next step, same as feature/bug/build.',
    developEagerness: 'expected-default',
    developsVia: 'bilko-host-publisher agent protocol (not /develop)',
  },
]

export const TAG_GROUP_ORDER: ReadonlyArray<EpicTag> = TAG_LIBRARY.map((entry) => entry.tag)

export function tagLibraryEntry(tag: EpicTag): TagLibraryEntry {
  const found = TAG_LIBRARY.find((entry) => entry.tag === tag)
  if (!found) throw new Error(`unknown tag: ${tag}`)
  return found
}
