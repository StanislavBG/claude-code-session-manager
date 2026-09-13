/**
 * backlogTree — turns a flat list of scheduler rows (jobs or PRDs) into the
 * REAL backlog hierarchy: Epic → dependency chain → row.
 *
 * `dependsOn` is documented (lib/dataModelErd.ts) as "the SOLE ordering
 * primitive"; `parallelGroup` is documented (CLAUDE.md's Avoid list) as "a
 * unique-per-PRD display hint, never a barrier." Before this module, the
 * renderer sorted and grouped by parallelGroup and never rendered dependsOn
 * at all — a human reading the queue could not tell why a row wasn't
 * running, what blocked it, or which rows belonged to the same Epic plan.
 *
 * Pure and side-effect-free by design: SchedulePanel/SchedulerPrdsView call
 * this from inside a `useMemo`, never from a zustand selector (a selector
 * returning a freshly-built tree every render is the React #185 blank-app
 * class of bug — see CLAUDE.md).
 */
import { resolveEpicRef, type EpicLinked } from './epicProvenance'
import type { PromptSession } from '../state/promptSessions'

/** The subset of a job/PRD row this module needs. `ScheduleJob` and
 *  `PrdListItem` both satisfy this structurally — no conversion needed. */
export interface BacklogRow extends EpicLinked {
  slug: string
  title: string
  /** null for a PRD row with no matching queue.json job yet. */
  status: string | null
  dependsOn?: string[] | null
  parallelGroup: number
}

export interface BacklogBlocker {
  slug: string
  /** null when `slug` doesn't match any known row — a dangling dependsOn. */
  status: string | null
  missing: boolean
  needsReview: boolean
}

export interface BacklogNode<Row extends BacklogRow = BacklogRow> {
  row: Row
  depth: number
  children: BacklogNode<Row>[]
  /** Every dependsOn entry on this row, resolved against ALL known rows
   *  (not just this row's Epic section) — a blocker can live in another
   *  Epic or be archived/gone entirely. */
  blockers: BacklogBlocker[]
  /** True when at least one non-missing blocker has not reached 'completed'. */
  blocked: boolean
  hasNeedsReviewBlocker: boolean
  hasMissingDep: boolean
  /** True when this row participates in a dependsOn cycle — rendered as a
   *  top-level warning row instead of being nested (or nesting anything),
   *  so a cycle can never recurse the tree builder into a hang. */
  cycle: boolean
  /** No dependsOn AND nothing in this row's Epic section depends on it —
   *  the thing the flat list hid: a row that could run any time. */
  parallelEligible: boolean
}

export interface BacklogEpicSection<Row extends BacklogRow = BacklogRow> {
  epicId: string | null
  label: string
  /** True when `label` is a real Epic goalText, false when it's a raw id
   *  (unresolved) or the literal "No Epic" fallback. */
  known: boolean
  /** Top-level nodes for this section (roots of the dependency forest) —
   *  each node's `children` carries the rest of its chain, in render order. */
  nodes: BacklogNode<Row>[]
  /** Rollup across every row in the section, keyed by status ('unknown' for
   *  a null status), for the section header's summary. */
  counts: Record<string, number>
  total: number
}

/**
 * Detects every row participating in a dependsOn cycle (including a
 * self-loop). O(V+E) in the common case; a pathological graph with many
 * distinct back-edges can push the `stack.indexOf` calls to O(V) each, but
 * backlog sizes (tens to low hundreds of PRDs) make that immaterial.
 */
function detectCycles(rows: BacklogRow[]): Set<string> {
  const bySlug = new Map(rows.map((r) => [r.slug, r]))
  const color = new Map<string, 1 | 2>()
  const cyclic = new Set<string>()
  const stack: string[] = []

  function visit(slug: string): void {
    color.set(slug, 1)
    stack.push(slug)
    const row = bySlug.get(slug)
    for (const dep of row?.dependsOn ?? []) {
      if (!bySlug.has(dep)) continue // dangling dep — flagged as missing, not a cycle
      const c = color.get(dep)
      if (c === 1) {
        const idx = stack.indexOf(dep)
        for (let i = idx; i < stack.length; i++) cyclic.add(stack[i])
      } else if (c === undefined) {
        visit(dep)
      }
    }
    stack.pop()
    color.set(slug, 2)
  }

  for (const r of rows) {
    if (!color.has(r.slug)) visit(r.slug)
  }
  return cyclic
}

function buildBlockers(row: BacklogRow, allBySlug: Map<string, BacklogRow>): BacklogBlocker[] {
  return (row.dependsOn ?? []).map((dep) => {
    const depRow = allBySlug.get(dep)
    if (!depRow) return { slug: dep, status: null, missing: true, needsReview: false }
    return { slug: dep, status: depRow.status, missing: false, needsReview: depRow.status === 'needs_review' }
  })
}

/** Builds the dependency forest for ONE Epic section. Nesting only ever
 *  happens within a section (that's the visual unit); a dependency that
 *  lives in another Epic (or nowhere at all) still shows up in `blockers`,
 *  it just doesn't change this row's place in the tree. */
function buildSectionNodes(
  sectionRows: BacklogRow[],
  allBySlug: Map<string, BacklogRow>,
  cyclic: Set<string>,
): BacklogNode[] {
  const sectionSlugs = new Set(sectionRows.map((r) => r.slug))
  const dependentsWithinSection = new Set<string>()
  for (const row of sectionRows) {
    for (const dep of row.dependsOn ?? []) {
      if (sectionSlugs.has(dep)) dependentsWithinSection.add(dep)
    }
  }

  const childrenBySlug = new Map<string, BacklogRow[]>()
  const roots: BacklogRow[] = []

  for (const row of sectionRows) {
    // A cyclic row is always rendered at top level, with its cycle called
    // out — never nested, and never used as another row's nesting parent
    // (that parent slot falls through to root too, see below).
    const nestableParent = cyclic.has(row.slug)
      ? undefined
      : (row.dependsOn ?? []).find((d) => sectionSlugs.has(d) && !cyclic.has(d))
    if (nestableParent) {
      if (!childrenBySlug.has(nestableParent)) childrenBySlug.set(nestableParent, [])
      childrenBySlug.get(nestableParent)!.push(row)
    } else {
      roots.push(row)
    }
  }

  const bySlugAlpha = (a: BacklogRow, b: BacklogRow) => a.slug.localeCompare(b.slug)
  roots.sort(bySlugAlpha)
  for (const list of childrenBySlug.values()) list.sort(bySlugAlpha)

  function makeNode(row: BacklogRow, depth: number, visiting: Set<string>): BacklogNode {
    const blockers = buildBlockers(row, allBySlug)
    const isCycle = cyclic.has(row.slug)
    visiting.add(row.slug)
    const kids = isCycle
      ? []
      : (childrenBySlug.get(row.slug) ?? [])
          // Belt-and-suspenders: the cyclic-set invariant already guarantees
          // childrenBySlug can't loop back to an ancestor, but a UI tree
          // builder must never be the thing that hangs the pane.
          .filter((child) => !visiting.has(child.slug))
          .map((child) => makeNode(child, depth + 1, visiting))
    visiting.delete(row.slug)
    return {
      row,
      depth,
      children: kids,
      blockers,
      blocked: blockers.some((b) => !b.missing && b.status !== 'completed'),
      hasNeedsReviewBlocker: blockers.some((b) => b.needsReview),
      hasMissingDep: blockers.some((b) => b.missing),
      cycle: isCycle,
      parallelEligible: (row.dependsOn ?? []).length === 0 && !dependentsWithinSection.has(row.slug),
    }
  }

  return roots.map((r) => makeNode(r, 0, new Set()))
}

/**
 * Groups `rows` by Epic (via the shared `resolveEpicRef` — same resolution
 * order every other Scheduler surface uses) and nests each Epic's rows by
 * their `dependsOn` chain. Complexity: O(V log V + E) — one linear pass to
 * group, cycle detection O(V+E), then a sort per section.
 *
 * `allRowsForBlockers` (defaults to `rows`) is the set blockers are resolved
 * against — see BacklogNode.blockers' own doc comment: "resolved against ALL
 * known rows ... a blocker can live in another Epic". A caller that has
 * already scoped `rows` down to one project (e.g. SchedulePanel's
 * cwd-filtered queue view) MUST still pass the full, unscoped row list here,
 * or a dependsOn on a job that merely lives in a DIFFERENT project — not
 * actually missing/archived — resolves as `missing: true` and renders a
 * false "blocked by X (missing)" warning.
 */
export function buildBacklogTree<Row extends BacklogRow>(
  rows: Row[],
  sessions: Record<string, PromptSession>,
  allRowsForBlockers?: BacklogRow[],
): BacklogEpicSection<Row>[] {
  const allBySlug = new Map<string, BacklogRow>((allRowsForBlockers ?? rows).map((r) => [r.slug, r]))
  const cyclic = detectCycles(rows)

  const sectionOrder: string[] = []
  const sectionRows = new Map<string, Row[]>()
  const sectionMeta = new Map<string, { epicId: string | null; label: string; known: boolean }>()

  for (const row of rows) {
    const ref = resolveEpicRef(row, sessions)
    const key = ref.epicId ?? '__none__'
    if (!sectionRows.has(key)) {
      sectionOrder.push(key)
      sectionRows.set(key, [])
      sectionMeta.set(key, {
        epicId: ref.epicId,
        label: ref.known && ref.label ? ref.label : ref.epicId ? `Epic ${ref.epicId.slice(0, 12)}…` : 'No Epic',
        known: ref.known,
      })
    }
    sectionRows.get(key)!.push(row)
  }

  const sections: BacklogEpicSection<Row>[] = sectionOrder.map((key) => {
    const meta = sectionMeta.get(key)!
    const rowsInSection = sectionRows.get(key)!
    const nodes = buildSectionNodes(rowsInSection, allBySlug, cyclic) as BacklogNode<Row>[]
    const counts: Record<string, number> = {}
    for (const row of rowsInSection) {
      const k = row.status ?? 'unknown'
      counts[k] = (counts[k] ?? 0) + 1
    }
    return { epicId: meta.epicId, label: meta.label, known: meta.known, nodes, counts, total: rowsInSection.length }
  })

  // No-Epic bucket always last; known Epics before unresolved ones; ties by label.
  sections.sort((a, b) => {
    if (a.epicId === null) return 1
    if (b.epicId === null) return -1
    if (a.known !== b.known) return a.known ? -1 : 1
    return a.label.localeCompare(b.label)
  })
  return sections
}

/** Pre-order flatten (parent immediately followed by its children) — the
 *  shape a flat `.map()`-rendered row list needs, each still carrying its
 *  own `depth` for indentation. */
export function flattenBacklogNodes<Row extends BacklogRow>(nodes: BacklogNode<Row>[]): BacklogNode<Row>[] {
  const out: BacklogNode<Row>[] = []
  const visit = (n: BacklogNode<Row>) => {
    out.push(n)
    for (const c of n.children) visit(c)
  }
  for (const n of nodes) visit(n)
  return out
}
