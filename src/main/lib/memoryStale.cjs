'use strict';

/**
 * Pure, deterministic staleness scorer for workspace memories. No fs/electron
 * access — all IO is injected via `entries` (pre-read) and `existsPath`
 * (predicate), so this module is unit-testable with zero mocking.
 */

const DAY_MS = 86_400_000;
const AGE_STALE_DAYS = 90;
const MAX_DEAD_REF_CANDIDATES = 20;

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
// Backtick-quoted repo-path-shaped tokens, optionally suffixed with a :line.
const PATH_TOKEN_RE = /`([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,5}(?::\d+)?)`/g;

const KNOWN_SOURCE_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'cjs', 'mjs', 'json', 'md', 'py', 'rb', 'go', 'rs',
  'java', 'c', 'h', 'cpp', 'hpp', 'css', 'scss', 'html', 'yml', 'yaml', 'sh',
  'txt', 'toml', 'lock', 'sql', 'php', 'swift', 'kt', 'vue',
]);

function stripName(name) {
  return name.replace(/\.md$/, '');
}

/**
 * Extract dead-ref candidate paths from a memory body.
 * Complexity: O(body length) — one regex pass, then O(candidates) filtering.
 */
function extractCandidates(body) {
  const seen = new Set();
  const out = [];
  let m;
  PATH_TOKEN_RE.lastIndex = 0;
  while ((m = PATH_TOKEN_RE.exec(body)) !== null) {
    if (out.length >= MAX_DEAD_REF_CANDIDATES) break;
    let token = m[1].replace(/:\d+$/, '');
    if (token.startsWith('/') || token.startsWith('~')) continue; // not repo-relative
    const ext = token.includes('.') ? token.split('.').pop().toLowerCase() : '';
    const hasSlash = token.includes('/');
    if (!hasSlash && !KNOWN_SOURCE_EXTENSIONS.has(ext)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * scoreMemories({ entries, now, existsPath })
 *
 * entries: Array<{ name, mtimeMs, body }>
 * now: ms epoch
 * existsPath: (relPath: string) => boolean
 *
 * Complexity: O(total body bytes) — a single pass per entry to extract
 * wikilink targets and dead-ref candidates; the inbound-link fold is
 * O(entries + total links), NOT O(n^2) substring scans.
 */
function scoreMemories({ entries, now, existsPath }) {
  // Signal 2 (pass 1): per-entry set of wikilink targets, deduped so repeated
  // links to the same slug within one body count once toward that slug's
  // inbound count.
  const perEntryTargets = entries.map((e) => {
    const targets = new Set();
    let m;
    WIKILINK_RE.lastIndex = 0;
    while ((m = WIKILINK_RE.exec(e.body)) !== null) {
      targets.add(m[1].trim());
    }
    return targets;
  });

  const inboundCounts = new Map();
  entries.forEach((e, i) => {
    const selfSlug = stripName(e.name);
    for (const target of perEntryTargets[i]) {
      if (target === selfSlug) continue; // a memory linking itself isn't an inbound reference
      inboundCounts.set(target, (inboundCounts.get(target) || 0) + 1);
    }
  });

  return entries.map((e) => {
    const ageDays = Math.floor((now - e.mtimeMs) / DAY_MS);
    const slug = stripName(e.name);
    const inboundLinks = inboundCounts.get(slug) || 0;

    const candidates = extractCandidates(e.body);
    const deadRefs = candidates.filter((c) => !existsPath(c));

    const reasons = [];
    if (deadRefs.length > 0) {
      reasons.push(
        deadRefs.length === 1
          ? 'references 1 path that no longer exists'
          : `references ${deadRefs.length} paths that no longer exist`
      );
    }
    const oldAndUnlinked = ageDays > AGE_STALE_DAYS && inboundLinks === 0;
    if (oldAndUnlinked) {
      reasons.push('90+ days old with no inbound links');
    }

    return {
      name: e.name,
      ageDays,
      inboundLinks,
      deadRefs,
      stale: deadRefs.length > 0 || oldAndUnlinked,
      reasons,
    };
  });
}

module.exports = { scoreMemories };
