'use strict';

/**
 * bilkoHostCore.cjs — pure logic for the "Host on Bilko.run" tab's
 * multi-document bundle model. No fs/IPC here (that's bilkoHost.cjs) so
 * this stays unit-testable without a real project directory.
 *
 * Model: ONE Bilko project (one registry slug, one `dist/` tree) can host
 * MANY documents — exactly one root document (subpath `''`, becomes
 * dist/index.html — "the project itself") plus any number of sub-path
 * documents (subpath 'special-doc/01', becomes dist/special-doc/01/
 * index.html → bilko.run/projects/<slug>/special-doc/01/). This mirrors how
 * Bilko's own publish_static_project already works: it `rm -rf`s then
 * `cp -r`s the WHOLE public/projects/<slug>/ tree on every publish, so
 * removing a document locally and re-publishing is guaranteed to remove it
 * live too — no separate per-document delete API needed on Bilko's side.
 */

const SUBPATH_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SEGMENTS = 6;
const MAX_SUBPATH_LENGTH = 200;

/**
 * Validates a document's subpath. `''` (root) is always valid. Otherwise
 * every '/'-separated segment must be lowercase kebab-case, no '.'/'..',
 * no leading/trailing/double slashes, bounded depth and length.
 */
function validateSubpath(subpath) {
  if (typeof subpath !== 'string') return { ok: false, error: 'subpath must be a string' };
  if (subpath === '') return { ok: true, error: null };
  if (subpath.length > MAX_SUBPATH_LENGTH) return { ok: false, error: 'subpath is too long' };
  if (subpath.startsWith('/') || subpath.endsWith('/')) {
    return { ok: false, error: 'subpath must not start or end with /' };
  }
  const segments = subpath.split('/');
  if (segments.length > MAX_SEGMENTS) return { ok: false, error: `subpath has more than ${MAX_SEGMENTS} segments` };
  for (const seg of segments) {
    if (!SUBPATH_SEGMENT.test(seg)) {
      return { ok: false, error: `invalid subpath segment "${seg}" — use lowercase kebab-case` };
    }
  }
  return { ok: true, error: null };
}

/**
 * Validates a full document list: subpaths individually valid, exactly one
 * root document, no duplicate subpaths. Pure — takes the array shape
 * documents.json stores, `[{ id, subpath, ... }]`.
 */
function validateDocumentSet(documents) {
  if (!Array.isArray(documents) || documents.length === 0) {
    return { ok: false, error: 'at least one document (the root) is required' };
  }
  const seen = new Set();
  let rootCount = 0;
  for (const doc of documents) {
    const v = validateSubpath(doc.subpath);
    if (!v.ok) return { ok: false, error: `document "${doc.id}": ${v.error}` };
    if (seen.has(doc.subpath)) return { ok: false, error: `duplicate subpath "${doc.subpath}"` };
    seen.add(doc.subpath);
    if (doc.subpath === '') rootCount += 1;
  }
  if (rootCount !== 1) return { ok: false, error: 'exactly one document must have subpath "" (the project root)' };
  return { ok: true, error: null };
}

/** Where a document's rendered HTML lands inside dist/. Pure path math. */
function documentDistRelPath(subpath) {
  return subpath === '' ? 'index.html' : `${subpath}/index.html`;
}

/**
 * The bilko.run URL a document resolves to once published, given the
 * project's slug. Pure — used by the tab to render "will be live at" links
 * before anything is actually published.
 */
function documentUrl(slug, subpath) {
  return subpath === '' ? `https://bilko.run/projects/${slug}/` : `https://bilko.run/projects/${slug}/${subpath}/`;
}

module.exports = {
  SUBPATH_SEGMENT,
  MAX_SEGMENTS,
  MAX_SUBPATH_LENGTH,
  validateSubpath,
  validateDocumentSet,
  documentDistRelPath,
  documentUrl,
};
