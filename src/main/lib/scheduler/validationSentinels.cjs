'use strict';

/**
 * validationSentinels.cjs — parses the `VALIDATION: <slug> VERIFIED` /
 * `VALIDATION: <slug> REFUTED — <reason>` lines a plan-level validator job
 * (persona `validator`, PRD 1405) emits, one per PRD it checked, at the end
 * of its run. Pure text-in/array-out; no filesystem or scheduler knowledge.
 */

const SENTINEL_RE = /^VALIDATION:\s+(\S+)\s+(VERIFIED|REFUTED)(?:\s*[—–-]+\s*(.*))?\s*$/gm;

/**
 * parseValidationSentinels(text) → Array<{ slug, verdict, reason }>
 *
 * `verdict` is lowercased ('verified' | 'refuted'); `reason` is '' when
 * absent. Last matching line per slug wins, but the ORDER of the returned
 * array follows each slug's first appearance in `text`, not its last.
 */
function parseValidationSentinels(text) {
  if (!text) return [];
  const bySlug = new Map();
  for (const match of text.matchAll(SENTINEL_RE)) {
    const [, slug, verdict, reason] = match;
    bySlug.set(slug, { slug, verdict: verdict.toLowerCase(), reason: reason || '' });
  }
  return Array.from(bySlug.values());
}

module.exports = { parseValidationSentinels };
