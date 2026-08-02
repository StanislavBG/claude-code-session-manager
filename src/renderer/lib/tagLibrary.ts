/**
 * Single source of truth for the Epic intent-tag taxonomy — the same
 * `'feature' | 'bug' | 'discussion' | 'build'` union tracked by
 * `state/promptSessions.ts` (`PromptSession['tag']`) and
 * `lib/ticketDisplay.ts` (`TicketTag`). Descriptions quote this project's own
 * CLAUDE.md "Domain model (TAB / EPIC)" section verbatim. `ticketDisplay.ts`
 * (tone/color) and `epicQueueControls.ts` (group order) both import the tag
 * list from here rather than keeping their own copies.
 */
export type EpicTag = 'feature' | 'bug' | 'discussion' | 'build' | 'project-home-builder'

export type DevelopEagerness = 'expected-default' | 'available-not-assumed'

export interface TagLibraryEntry {
  tag: EpicTag
  label: string
  description: string
  developEagerness: DevelopEagerness
}

export const TAG_LIBRARY: TagLibraryEntry[] = [
  {
    tag: 'feature',
    label: 'Feature',
    description:
      'The tag also sets how eagerly /develop should fire inside that Epic\'s session — see the session-manager-dev:develop skill\'s "Tag-aware default": feature/bug treat PRD decomposition as the expected next step.',
    developEagerness: 'expected-default',
  },
  {
    tag: 'bug',
    label: 'Bug',
    description:
      'The tag also sets how eagerly /develop should fire inside that Epic\'s session — see the session-manager-dev:develop skill\'s "Tag-aware default": feature/bug treat PRD decomposition as the expected next step.',
    developEagerness: 'expected-default',
  },
  {
    tag: 'discussion',
    label: 'Discussion',
    description:
      'discussion keeps /develop available but never assumed until whether-to-build is actually settled.',
    developEagerness: 'available-not-assumed',
  },
  {
    tag: 'build',
    label: 'Build',
    description:
      "A build Epic's whole point is to run the Builder skill — decomposition into PRDs (or a direct build run) is the expected next step, the same as feature/bug.",
    developEagerness: 'expected-default',
  },
  {
    tag: 'project-home-builder',
    label: 'Project Home Builder',
    description:
      'Generates a project\'s 3 static Project Page HTML files via the project-home-builder local agent — see session-manager-operations/architecture/project-pages-pipeline.md. Decomposition into PRDs is the expected next step, same as feature/bug/build.',
    developEagerness: 'expected-default',
  },
]

export const TAG_GROUP_ORDER: ReadonlyArray<EpicTag> = TAG_LIBRARY.map((entry) => entry.tag)

export function tagLibraryEntry(tag: EpicTag): TagLibraryEntry {
  const found = TAG_LIBRARY.find((entry) => entry.tag === tag)
  if (!found) throw new Error(`unknown tag: ${tag}`)
  return found
}
