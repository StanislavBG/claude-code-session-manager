'use strict';

/**
 * prdDisposition.cjs — the wave-authoring decision (scheduler wave-
 * disposition PRD): when a new PRD wave joins an Epic that already has
 * incomplete PRDs, does the wave APPEND behind the existing chain's tail, or
 * start an independent NEW-HEAD root eligible to run in parallel? Before
 * this module the choice didn't exist — every new root PRD silently landed
 * as a parallel-eligible row, so waves interleaved with no recorded
 * relationship and a human reading the backlog couldn't tell a plan from a
 * pile.
 *
 * Two call sites:
 *   - prdCreate.cjs's createPrd() — AUTHORING TIME. Resolves 'append' into a
 *     concrete dependsOn via resolveChainTerminals() over the Epic's
 *     existing rows.
 *   - scheduler.cjs's `schedule:set-prd-disposition` IPC handler — CHANGING
 *     an already-written PRD's disposition from the Scheduler UI. Uses
 *     computeDispositionRewrite() to validate the rewrite is safe before
 *     handing the new dependsOn to remote.updatePrd (which itself refuses a
 *     non-pending/quarantined row — see scheduler.cjs's updatePrd).
 *
 * `rows` throughout is the same shape listPrdsInternal() already produces:
 * { slug, status, dependsOn }. dependsOn entries are resolved against `rows`
 * via depSlugResolve.cjs's resolveDepSlug — the SAME rule
 * schedulerBatch.cjs's findBlockingDep and prdCreate.cjs's write-time FK
 * check use, so a terminal/cycle computed here can never disagree with what
 * the scheduler considers a row's real blockers at run time.
 */

const { resolveDepSlug } = require('./depSlugResolve.cjs');

/** A row is "incomplete" (still part of the Epic's active plan) unless it
 *  has actually finished. Treats every other status — including a brand-new
 *  row with no queue entry yet (`status: null`) — as incomplete, since none
 *  of those represent shipped work a wave could safely ignore. */
function isIncomplete(status) {
  return status !== 'completed';
}

/** Resolve each row's dependsOn entries to actual row slugs present in
 *  `rows`, via the shared resolution rule. A dep that doesn't resolve to
 *  anything in this row set (dangling, or lives outside this Epic) is
 *  dropped — it can't affect this Epic's own terminal computation. */
function resolvedDependents(rows) {
  const slugs = rows.map((r) => r.slug);
  const dependedUpon = new Set();
  for (const r of rows) {
    for (const dep of r.dependsOn ?? []) {
      for (const resolved of resolveDepSlug(dep, slugs)) dependedUpon.add(resolved);
    }
  }
  return dependedUpon;
}

/** Every row participating in a dependsOn cycle within `rows` (self-loops
 *  included) — mirrors backlogTree.ts's detectCycles (renderer-only, can't
 *  be required from this CJS main-process module; kept in sync by hand). */
function detectCycles(rows) {
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const slugs = rows.map((r) => r.slug);
  const color = new Map();
  const cyclic = new Set();
  const stack = [];

  function visit(slug) {
    color.set(slug, 1);
    stack.push(slug);
    const r = bySlug.get(slug);
    const deps = new Set();
    for (const dep of r?.dependsOn ?? []) {
      for (const resolved of resolveDepSlug(dep, slugs)) deps.add(resolved);
    }
    for (const dep of deps) {
      const c = color.get(dep);
      if (c === 1) {
        const idx = stack.indexOf(dep);
        for (let i = idx; i < stack.length; i++) cyclic.add(stack[i]);
      } else if (c === undefined) {
        visit(dep);
      }
    }
    stack.pop();
    color.set(slug, 2);
  }

  for (const r of rows) {
    if (!color.has(r.slug)) visit(r.slug);
  }
  return cyclic;
}

/**
 * Terminal (leaf) slugs of the dependency forest formed by `rows` — the
 * row(s) nothing else in `rows` depends on. This is what an 'append'
 * disposition attaches a new wave's root behind: depending on every current
 * terminal means the new wave runs only once everything already queued (in
 * every existing head) has finished, the conservative reading of "append".
 * A row participating in a cycle is excluded — never used as a rewrite
 * target, since a cycle indicates the existing graph shouldn't be extended
 * until it's fixed by hand.
 */
function resolveChainTerminals(rows) {
  if (!rows.length) return [];
  const dependedUpon = resolvedDependents(rows);
  const cyclic = detectCycles(rows);
  return rows
    .map((r) => r.slug)
    .filter((slug) => !dependedUpon.has(slug) && !cyclic.has(slug));
}

/**
 * Would setting `slug`'s dependsOn to `newDependsOn` create a cycle? Checks
 * reachability from each (resolved) proposed dependency back to `slug`
 * following the EXISTING graph in `rows` (never `slug`'s own current
 * dependsOn, which is being replaced) — a direct self-reference is always a
 * cycle, checked first without needing a graph walk.
 */
function wouldCreateCycle(rows, slug, newDependsOn) {
  const slugs = rows.map((r) => r.slug);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const resolvedTargets = new Set();
  for (const dep of newDependsOn) {
    for (const resolved of resolveDepSlug(dep, slugs)) resolvedTargets.add(resolved);
  }
  if (resolvedTargets.has(slug)) return true;

  const visited = new Set();
  function reachesSlug(from) {
    if (from === slug) return true;
    if (visited.has(from)) return false;
    visited.add(from);
    const r = bySlug.get(from);
    for (const dep of r?.dependsOn ?? []) {
      for (const resolved of resolveDepSlug(dep, slugs)) {
        if (reachesSlug(resolved)) return true;
      }
    }
    return false;
  }
  for (const target of resolvedTargets) {
    if (reachesSlug(target)) return true;
  }
  return false;
}

/**
 * Validates and computes the new dependsOn for a disposition change on an
 * already-written PRD (the Scheduler UI's "promote to head" / "attach
 * behind another chain" action). Pure — returns the new dependsOn value on
 * success; the caller (scheduler.cjs's IPC handler) is responsible for
 * actually persisting it via remote.updatePrd, which independently refuses
 * a non-pending/quarantined row (defense in depth, not duplicated here).
 *
 * Refuses (ok: false) when:
 *   - `slug` isn't a known row.
 *   - the row itself is 'running' or 'completed' — never touch live or
 *     shipped work.
 *   - any of the row's CURRENT dependsOn entries already resolved
 *     ('completed') — the row may already be scheduler-eligible, and
 *     rewriting its ordering out from under a resolved blocker risks
 *     resurrecting/racing already-finished work (see this module's header).
 *   - the proposed dependsOn would create a cycle.
 */
function computeDispositionRewrite({ slug, disposition, dependsOn, rows }) {
  const row = rows.find((r) => r.slug === slug);
  if (!row) return { ok: false, error: `PRD not found: ${slug}` };
  if (row.status === 'running' || row.status === 'completed') {
    return { ok: false, error: `cannot change disposition of a "${row.status}" PRD — it is no longer part of the open plan` };
  }

  const slugs = rows.map((r) => r.slug);
  for (const dep of row.dependsOn ?? []) {
    for (const resolved of resolveDepSlug(dep, slugs)) {
      const depRow = rows.find((r) => r.slug === resolved);
      if (depRow?.status === 'completed') {
        return {
          ok: false,
          error: `refusing to rewrite dependsOn: blocker "${resolved}" has already completed — this PRD may ` +
            'already be eligible to run; changing its ordering now risks resurrecting finished work',
        };
      }
    }
  }

  const newDependsOn = disposition === 'new-head' ? [] : Array.from(new Set(dependsOn ?? []));
  if (newDependsOn.length && wouldCreateCycle(rows, slug, newDependsOn)) {
    return { ok: false, error: `dependsOn ${JSON.stringify(newDependsOn)} would create a dependency cycle` };
  }

  return { ok: true, dependsOn: newDependsOn };
}

module.exports = {
  isIncomplete,
  resolveChainTerminals,
  wouldCreateCycle,
  computeDispositionRewrite,
};
