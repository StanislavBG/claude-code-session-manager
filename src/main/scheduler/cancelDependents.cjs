'use strict';

/**
 * cancelDependents.cjs — pure planning for remote.cancelJob's dependents
 * choice (PRD 3499). Cancelling a row with pending dependents used to leave
 * every dependent pointing at a dead (failed) row — the 2026-11-22 Self stall.
 * cancelJob now refuses unless the caller says what happens to them:
 *
 *   cascade — cancel every pending dependent, transitively
 *   repoint — replace the dep on the target with `to` (resolved to a full slug)
 *   clear   — drop the dep on the target
 *
 * No I/O here: scheduler.cjs reads the queue, calls these, then applies the
 * edits (updatePrd for repoint/clear, one mutate for cascade + target).
 */

const { makeDepResolver, resolveDepSlug } = require('../lib/prd/depSlugResolve.cjs');
const { wouldCreateCycle } = require('../lib/prd/prdDisposition.cjs');

const DEPENDENTS_ACTIONS = Object.freeze(['cascade', 'repoint', 'clear']);

function projectRows(jobs, cwd) {
  return (Array.isArray(jobs) ? jobs : []).filter((j) => j && (cwd == null || j.cwd === cwd));
}

function findTarget(rows, slug) {
  return rows.find((j) => j.slug === slug) ?? null;
}

/**
 * The deps of `dependent` that resolve to `target` under the shared run-time
 * rule (exact slug, else bare name with Epic preference).
 */
function depsNamingTarget(resolver, dependent, target) {
  const out = [];
  for (const dep of Array.isArray(dependent.dependsOn) ? dependent.dependsOn : []) {
    if (resolver.resolve(dep, dependent).rows.includes(target)) out.push(dep);
  }
  return out;
}

/**
 * Pending rows of `cwd` whose dependsOn resolves to the row `slug`. Rows of
 * other projects never count, even with a matching bare name. Returns
 * [{ slug, deps }] in queue order; [] when the target is not in that cwd.
 */
function findPendingDependents(jobs, slug, cwd) {
  const rows = projectRows(jobs, cwd);
  const target = findTarget(rows, slug);
  if (!target) return [];
  const resolver = makeDepResolver(rows);
  const out = [];
  for (const j of rows) {
    if (j === target || j.status !== 'pending') continue;
    const deps = depsNamingTarget(resolver, j, target);
    if (deps.length > 0) out.push({ slug: j.slug, deps });
  }
  return out;
}

/** Every pending dependent of `slug`, transitively (BFS order, target excluded). */
function findTransitiveDependents(jobs, slug, cwd) {
  const seen = new Set([slug]);
  const order = [];
  const queue = [slug];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const d of findPendingDependents(jobs, cur, cwd)) {
      if (seen.has(d.slug)) continue;
      seen.add(d.slug);
      order.push(d.slug);
      queue.push(d.slug);
    }
  }
  return order;
}

/**
 * planDependentsUpdate(jobs, slug, choice, cwd?) →
 *   { ok: true, action, to, dependents: string[], edits: [...] }
 *   | { ok: false, error }
 * `choice` is { action, to? }; `cwd` defaults to `choice.cwd`, else the target
 * row's own cwd. Edits:
 *   cascade → { slug, action: 'cancel', reason }          (transitive set)
 *   repoint → { slug, action: 'setDependsOn', dependsOn, previous }
 *   clear   → { slug, action: 'setDependsOn', dependsOn, previous }
 */
function planDependentsUpdate(jobs, slug, choice, cwd) {
  const action = choice?.action;
  if (!DEPENDENTS_ACTIONS.includes(action)) {
    return { ok: false, error: `dependents.action must be one of ${DEPENDENTS_ACTIONS.join(', ')}` };
  }
  const all = Array.isArray(jobs) ? jobs : [];
  const scopeCwd = cwd ?? choice?.cwd ?? all.find((j) => j?.slug === slug)?.cwd ?? null;
  const rows = projectRows(all, scopeCwd);
  const target = findTarget(rows, slug);
  if (!target) return { ok: false, error: `unknown slug "${slug}"` };

  if (action === 'cascade') {
    const dependents = findTransitiveDependents(rows, slug, scopeCwd);
    const reason = `cancelled via admin API (cascade: depends on cancelled ${slug})`;
    return {
      ok: true, action, to: null, dependents,
      edits: dependents.map((s) => ({ slug: s, action: 'cancel', reason })),
    };
  }

  const direct = findPendingDependents(rows, slug, scopeCwd);
  const dependents = direct.map((d) => d.slug);
  let resolvedTo = null;
  if (action === 'repoint') {
    const to = typeof choice.to === 'string' ? choice.to.trim() : '';
    if (!to) return { ok: false, error: 'dependents.action "repoint" requires dependents.to' };
    const matches = resolveDepSlug(to, rows.map((r) => r.slug));
    if (matches.length === 0) {
      return { ok: false, error: `dependents.to "${to}" does not resolve to any queued PRD in this project` };
    }
    if (matches.length > 1) {
      return { ok: false, error: `dependents.to "${to}" is ambiguous (matches ${matches.join(', ')}) — pass the full NN-prefixed slug` };
    }
    resolvedTo = matches[0];
    if (resolvedTo === slug) {
      return { ok: false, error: `dependents.to "${to}" resolves to the job being cancelled (${slug})` };
    }
  }

  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const edits = [];
  for (const d of direct) {
    const row = bySlug.get(d.slug);
    const previous = Array.isArray(row.dependsOn) ? [...row.dependsOn] : [];
    const drop = new Set(d.deps);
    const next = [];
    for (const dep of previous) {
      const replacement = drop.has(dep) ? resolvedTo : dep;
      if (replacement != null && !next.includes(replacement)) next.push(replacement);
    }
    if (action === 'repoint') {
      const cycleRows = rows.map((r) => ({ slug: r.slug, dependsOn: r.dependsOn ?? [] }));
      if (wouldCreateCycle(cycleRows, d.slug, next)) {
        return { ok: false, error: `repointing ${d.slug} to ${resolvedTo} would create a dependency cycle` };
      }
    }
    edits.push({ slug: d.slug, action: 'setDependsOn', dependsOn: next, previous });
  }
  return { ok: true, action, to: resolvedTo, dependents, edits };
}

module.exports = {
  DEPENDENTS_ACTIONS,
  findPendingDependents,
  findTransitiveDependents,
  planDependentsUpdate,
};
