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

// Project roots a memory names: `~/x/y` or `/home/<user>/x/y`, backticked or not.
const ROOT_TOKEN_RE = /(?:~|\/home\/[^/\s`]+)\/[A-Za-z0-9_.\-/]+/g;
const MAX_ROOTS = 5;

function stripName(name) {
  return name.replace(/\.md$/, '');
}

/**
 * Frontmatter meta from a leading `---` block only. `type:` / `originSessionId:`
 * match at any indentation (real files nest them under `metadata:`).
 */
function parseMeta(body) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!fm) return { description: null, type: null, originSessionId: null };
  const pick = (key) => {
    const m = new RegExp(`^[ \\t]*${key}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(fm[1]);
    return m ? m[1] : null;
  };
  let description = pick('description');
  if (description !== null) description = description.replace(/^"(.*)"$/, '$1');
  return { description, type: pick('type'), originSessionId: pick('originSessionId') };
}

/**
 * Top-level (unindented) frontmatter `name:` value, surrounding quotes
 * stripped. A sibling of parseMeta so the result's `name` (the filename) is
 * never clobbered by the meta spread.
 */
function parseFrontmatterName(body) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!fm) return null;
  const m = /^name:[ \t]*(.+?)[ \t]*$/m.exec(fm[1]);
  if (!m) return null;
  const v = m[1].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim();
  return v || null;
}

/** Lowercase; collapse runs of '-', '_' and whitespace to a single '-'. */
function normalizeLinkKey(s) {
  return String(s).trim().toLowerCase().replace(/[-_\s]+/g, '-');
}

/**
 * makeLinkResolver(entries) => (target) => canonical filename stem | null
 *
 * entries: Array<{ name, body }>. A wikilink target matches an entry when its
 * normalized form equals the normalized filename stem OR the normalized
 * frontmatter `name:` (Claude Code links memories by the kebab frontmatter
 * name while files are snake_case). Collisions: an exact stem match wins;
 * otherwise filename stems claim keys before frontmatter names, and within
 * each pass the entry whose filename sorts first wins — independent of input
 * order. Complexity: O(entries log entries) build, O(target length) lookup.
 */
function makeLinkResolver(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const exactStems = new Set();
  const byKey = new Map();
  for (const e of sorted) {
    const stem = stripName(e.name);
    exactStems.add(stem);
    const key = normalizeLinkKey(stem);
    if (!byKey.has(key)) byKey.set(key, stem);
  }
  for (const e of sorted) {
    const fmName = parseFrontmatterName(e.body || '');
    if (fmName === null) continue;
    const key = normalizeLinkKey(fmName);
    if (!byKey.has(key)) byKey.set(key, stripName(e.name));
  }
  return (target) => {
    const t = String(target).trim();
    if (exactStems.has(t)) return t;
    return byKey.get(normalizeLinkKey(t)) ?? null;
  };
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
    // A bare filename can never resolve from the repo root — only slashed paths are checkable.
    if (!token.includes('/')) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * Extract up to MAX_ROOTS distinct directory tokens (`~/...`, `/home/<user>/...`)
 * named anywhere in the body, so a sibling-repo path can resolve against them.
 * Pure, no fs.
 */
function extractRoots(body) {
  const out = [];
  let m;
  ROOT_TOKEN_RE.lastIndex = 0;
  while ((m = ROOT_TOKEN_RE.exec(body)) !== null) {
    const root = m[0].replace(/[/.,)]+$/, '');
    if (!root.includes('/') || out.includes(root)) continue;
    out.push(root);
    if (out.length >= MAX_ROOTS) break;
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile projectRoots ({name, root}[]) into whole-word, case-insensitive
 * matchers. A word boundary is any non-[A-Za-z0-9_] char, so 'Bilko' matches
 * 'bilko-run' but not 'notbilkos'.
 */
function compileProjectRoots(projectRoots) {
  return projectRoots
    .filter((p) => p && typeof p.name === 'string' && p.name !== '' && typeof p.root === 'string' && p.root !== '')
    .map((p) => ({ root: p.root, re: new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(p.name)}(?![A-Za-z0-9_])`, 'i') }));
}

/**
 * scoreMemories({ entries, now, existsPath, projectRoots, renamedTo })
 *
 * entries: Array<{ name, mtimeMs, body }>
 * now: ms epoch
 * existsPath: (relPath: string, roots?: string[]) => boolean
 * projectRoots: Array<{ name, root }> — a root joins a memory's roots when its
 *   name appears in the body as a whole word (case-insensitive)
 * renamedTo: (relPath) => string | null — git rename target; a dead candidate
 *   whose target exists is reported in movedRefs, not deadRefs, and is not stale
 *
 * Complexity: O(total body bytes) — a single pass per entry to extract
 * wikilink targets and dead-ref candidates; the inbound-link fold is
 * O(entries + total links), NOT O(n^2) substring scans.
 */
function scoreMemories({ entries, now, existsPath, projectRoots = [], renamedTo = () => null }) {
  const projectMatchers = compileProjectRoots(projectRoots);
  // Signal 2 (pass 1): per-entry set of wikilink targets, each resolved to its
  // canonical filename stem (raw text when unresolved), deduped so repeated
  // links to the same memory within one body count once toward its inbound
  // count. Self-links (by stem or frontmatter name) are dropped here.
  const resolve = makeLinkResolver(entries);
  const perEntryTargets = entries.map((e) => {
    const selfSlug = stripName(e.name);
    const targets = new Set();
    const dangling = new Set();
    let m;
    WIKILINK_RE.lastIndex = 0;
    while ((m = WIKILINK_RE.exec(e.body)) !== null) {
      const raw = m[1].trim();
      const canonical = resolve(raw);
      if (canonical === null) {
        targets.add(raw);
        dangling.add(raw);
      } else if (canonical !== selfSlug) {
        targets.add(canonical);
      }
    }
    return { targets, dangling };
  });

  const inboundCounts = new Map();
  for (const { targets, dangling } of perEntryTargets) {
    for (const target of targets) {
      if (dangling.has(target)) continue;
      inboundCounts.set(target, (inboundCounts.get(target) || 0) + 1);
    }
  }

  return entries.map((e, i) => {
    const ageDays = Math.floor((now - e.mtimeMs) / DAY_MS);
    const slug = stripName(e.name);
    const inboundLinks = inboundCounts.get(slug) || 0;

    const candidates = extractCandidates(e.body);
    const roots = extractRoots(e.body);
    for (const { root, re } of projectMatchers) {
      if (!roots.includes(root) && re.test(e.body)) roots.push(root);
    }
    const deadRefs = [];
    const movedRefs = [];
    for (const c of candidates) {
      if (existsPath(c, roots)) continue;
      const to = renamedTo(c);
      if (typeof to === 'string' && to !== '' && to !== c && existsPath(to, roots)) movedRefs.push({ from: c, to });
      else deadRefs.push(c);
    }

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

    const { targets, dangling } = perEntryTargets[i];
    const outLinks = [...targets];

    return {
      name: e.name,
      ...parseMeta(e.body),
      outLinks,
      danglingLinks: [...dangling],
      ageDays,
      inboundLinks,
      deadRefs,
      movedRefs,
      stale: deadRefs.length > 0 || oldAndUnlinked,
      reasons,
    };
  });
}

module.exports = { scoreMemories, extractRoots, makeLinkResolver };
