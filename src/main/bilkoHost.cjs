'use strict';

/**
 * bilkoHost.cjs — Stage A (deterministic bundle prep) for the "Host on
 * Bilko.run" tab. See session-manager-operations/architecture/
 * bilko-host-integration.md for the full design.
 *
 * Model: ONE Bilko project (slug) hosts a LIST of documents — a root
 * document (subpath '', dist/index.html — "the project itself") plus any
 * number of sub-path documents (subpath 'special-doc/01',
 * dist/special-doc/01/index.html → bilko.run/projects/<slug>/special-doc/01/).
 * `documents.json` is the list; `dist/` is always rebuilt wholesale from it
 * (rm + rewrite) so it can never drift from the list — the same "full
 * replace" semantics Bilko's own publish_static_project already uses, which
 * is exactly what makes local deletion reliably propagate live (see
 * bilkoHostCore.cjs's header comment).
 *
 * This module owns `session-manager-operations/bilko-host/documents.json` +
 * `dist/{**,manifest.json}` (writer id `bilko-host`, OWNERS-enforced via
 * config.cjs's write helpers). It never talks to the bilko-host MCP itself
 * and never writes publish-state.json — that's Stage B, run by the
 * bilko-host-publisher Epic's own session with its own Write tool
 * (agent-authored artifact, same as project-pages/output/*.html; not
 * enforceable by OWNERS). Directory removal (rm -rf of dist/ before a
 * rebuild) uses raw fs directly, same precedent as epicMint.cjs/
 * queueStore.cjs using raw fs for their own owned namespace — this module
 * IS the declared owner of `bilko-host`, so there is no foreign-writer risk
 * to guard against here.
 */

const { ipcMain } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { gzipSync } = require('node:zlib');
const config = require('./config.cjs');
const {
  validateSubpath,
  validateDocumentSet,
  documentDistRelPath,
  documentUrl,
} = require('./bilkoHostCore.cjs');

const WRITER = 'bilko-host';
const PROJECT_PAGE_LENSES = new Set(['home', 'marketing', 'feature', 'architecture']);

function bilkoHostDir(cwd) {
  return path.join(cwd, 'session-manager-operations', 'bilko-host');
}

function distDir(cwd) {
  return path.join(bilkoHostDir(cwd), 'dist');
}

function documentsPath(cwd) {
  return path.join(bilkoHostDir(cwd), 'documents.json');
}

/** Kebab-case a project name into a slug candidate. Pure. */
function deriveSlug(projectDirName) {
  return String(projectDirName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'project';
}

function gitInfo(cwd) {
  const run = (args, fallback) => {
    try {
      return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return fallback;
    }
  };
  return {
    gitSha: run(['rev-parse', '--short', 'HEAD'], '0000000'),
    gitBranch: run(['rev-parse', '--abbrev-ref', 'HEAD'], 'main'),
  };
}

async function readDocuments(cwd) {
  const result = await config.readJson(documentsPath(cwd));
  if (result.exists && !result.parseError && Array.isArray(result.data?.documents)) {
    return result.data.documents;
  }
  return null;
}

async function writeDocuments(cwd, documents) {
  await config.writeJson(documentsPath(cwd), { documents }, { writer: WRITER });
}

/**
 * Reads everything the tab needs to render its status card: whether a
 * Project Page exists to seed a root document from, the project's
 * package.json (for the compatibility gate + default slug/version), the
 * current document list, and any bundle/publish state already on disk.
 */
async function get({ cwd }) {
  const realCwd = config.validatePath(cwd);

  const marketingResult = await config.readText(
    path.join(realCwd, 'session-manager-operations', 'project-pages', 'output', 'marketing.html'),
  );
  const pkgResult = await config.readJson(path.join(realCwd, 'package.json'));
  const pkg = pkgResult.exists && !pkgResult.parseError ? pkgResult.data : null;

  const documents = (await readDocuments(realCwd)) ?? [];

  const bundleManifestResult = await config.readJson(path.join(distDir(realCwd), 'manifest.json'));
  const bundleManifest = bundleManifestResult.exists && !bundleManifestResult.parseError
    ? bundleManifestResult.data
    : null;

  const publishStateResult = await config.readJson(path.join(bilkoHostDir(realCwd), 'publish-state.json'));
  const publishState = publishStateResult.exists && !publishStateResult.parseError
    ? publishStateResult.data
    : null;

  const slug = bundleManifest?.slug
    ?? deriveSlug(pkg && typeof pkg.name === 'string' ? pkg.name : path.basename(realCwd));

  return {
    hasMarketingPage: marketingResult.exists,
    projectName: pkg && typeof pkg.name === 'string' ? pkg.name : path.basename(realCwd),
    packagePrivate: pkg ? pkg.private === true : false,
    packageHomepage: pkg && typeof pkg.homepage === 'string' ? pkg.homepage : null,
    packageVersion: pkg && typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    defaultSlug: deriveSlug(pkg && typeof pkg.name === 'string' ? pkg.name : path.basename(realCwd)),
    documents: documents.map((d) => ({ ...d, url: documentUrl(slug, d.subpath) })),
    // A rebuild is owed whenever the bundle on disk doesn't reflect the
    // current document list — the tab uses this to gray out "up to date"
    // vs. prompt "Prepare Bundle" again, and (post-publish) to warn that a
    // removed document is still live until the next Publish.
    bundleStale: bundleManifest ? bundleManifest.documentCount !== documents.length : documents.length > 0,
    bundleManifest,
    publishState,
  };
}

/** Seeds documents.json with a single root document (the Marketing Project Page) if it doesn't exist yet. */
async function ensureSeededDocuments(cwd) {
  const existing = await readDocuments(cwd);
  if (existing) return existing;
  const seeded = [{
    id: crypto.randomUUID(),
    subpath: '',
    title: 'Project (Marketing)',
    source: { kind: 'project-page-lens', lens: 'marketing' },
    addedAt: new Date().toISOString(),
  }];
  await writeDocuments(cwd, seeded);
  return seeded;
}

/**
 * Add a hosted document. `source` is either
 * `{ kind: 'project-page-lens', lens: 'home'|'marketing'|'feature'|'architecture' }`
 * (reuses an already-generated Project Page lens) or
 * `{ kind: 'file', path: <repo-relative path> }` (any other local HTML —
 * e.g. a HUMAN_LEARN page or a hand-authored explainer).
 */
async function addDocument({ cwd, subpath, title, source }) {
  const realCwd = config.validatePath(cwd);
  const subpathCheck = validateSubpath(subpath);
  if (!subpathCheck.ok) throw new Error(subpathCheck.error);
  if (source.kind === 'project-page-lens' && !PROJECT_PAGE_LENSES.has(source.lens)) {
    throw new Error(`unknown Project Page lens: ${source.lens}`);
  }

  const documents = (await readDocuments(realCwd)) ?? await ensureSeededDocuments(realCwd);
  if (subpath === '') {
    throw new Error('the root document (subpath "") always exists — edit it instead of adding a second one');
  }
  if (documents.some((d) => d.subpath === subpath)) {
    throw new Error(`a document already uses subpath "${subpath}"`);
  }

  const next = [...documents, {
    id: crypto.randomUUID(),
    subpath,
    title,
    source,
    addedAt: new Date().toISOString(),
  }];
  const setCheck = validateDocumentSet(next);
  if (!setCheck.ok) throw new Error(setCheck.error);

  await writeDocuments(realCwd, next);
  return { documents: next };
}

/**
 * Remove a hosted document (never the root). This only updates
 * documents.json — the file stays in `dist/` (and, if already published,
 * live on bilko.run) until the next Prepare Bundle + Publish, which is the
 * confirmed mechanism that actually removes it (Bilko's publish tool
 * rm -rf's + rebuilds the whole slug directory every publish).
 */
async function removeDocument({ cwd, id }) {
  const realCwd = config.validatePath(cwd);
  const documents = (await readDocuments(realCwd)) ?? [];
  const target = documents.find((d) => d.id === id);
  if (!target) throw new Error(`no document with id ${id}`);
  if (target.subpath === '') throw new Error('cannot remove the root document');

  const next = documents.filter((d) => d.id !== id);
  await writeDocuments(realCwd, next);
  return { documents: next };
}

async function resolveDocumentHtml(cwd, doc) {
  if (doc.source.kind === 'project-page-lens') {
    const result = await config.readText(
      path.join(cwd, 'session-manager-operations', 'project-pages', 'output', `${doc.source.lens}.html`),
    );
    if (!result.exists) {
      throw new Error(`document "${doc.title}" points at the ${doc.source.lens} Project Page, but it hasn't been generated yet`);
    }
    return result.text;
  }
  if (doc.source.kind === 'file') {
    const abs = config.validatePath(path.join(cwd, doc.source.path));
    const result = await config.readText(abs);
    if (!result.exists) throw new Error(`document "${doc.title}"'s source file is missing: ${doc.source.path}`);
    return result.text;
  }
  throw new Error(`unknown document source kind: ${doc.source.kind}`);
}

/**
 * Stage A: rebuild the ENTIRE dist/ tree from documents.json (rm + rewrite,
 * mirroring Bilko's own full-replace publish semantics so local state can
 * never lag the document list) + dist/manifest.json (host-contract manifest
 * schema, one per bundle — golden.path/expect always point at the root
 * document). Idempotent.
 */
async function prepareBundle({ cwd, slug }) {
  const realCwd = config.validatePath(cwd);
  const documents = await ensureSeededDocuments(realCwd);

  const setCheck = validateDocumentSet(documents);
  if (!setCheck.ok) throw new Error(setCheck.error);

  const pkgResult = await config.readJson(path.join(realCwd, 'package.json'));
  const pkg = pkgResult.exists && !pkgResult.parseError ? pkgResult.data : {};
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';

  const dist = distDir(realCwd);
  await fsp.rm(dist, { recursive: true, force: true });

  let totalGz = 0;
  for (const doc of documents) {
    const html = await resolveDocumentHtml(realCwd, doc);
    const relPath = documentDistRelPath(doc.subpath);
    await config.writeTextAtomic(path.join(dist, relPath), html, { writer: WRITER });
    totalGz += gzipSync(Buffer.from(html, 'utf8')).length;
  }

  const { gitSha, gitBranch } = gitInfo(realCwd);
  const goldenExpect = pkg && typeof pkg.name === 'string' ? pkg.name : slug;

  const manifest = {
    schemaVersion: 1,
    slug,
    version,
    builtAt: new Date().toISOString(),
    gitSha,
    gitBranch,
    hostKit: { version: '0.0.0' },
    golden: { path: `/projects/${slug}/`, expect: goldenExpect },
    health: {},
    bundle: { sizeBytesGz: totalGz, fileCount: documents.length },
    // Not part of the host-contract schema itself — this app's own staleness
    // check (get()'s bundleStale) compares this against documents.length.
    documentCount: documents.length,
    documents: documents.map((d) => ({ subpath: d.subpath, title: d.title })),
  };

  await config.writeJson(path.join(dist, 'manifest.json'), manifest, { writer: WRITER });

  return { distPath: dist, manifest };
}

function registerBilkoHostIpc() {
  const { schemas: s, validated: v } = require('./ipcSchemas.cjs');
  ipcMain.handle('bilko-host:get', v(s.bilkoHostCwd, get));
  ipcMain.handle('bilko-host:prepare-bundle', v(s.bilkoHostPrepareBundle, prepareBundle));
  ipcMain.handle('bilko-host:add-document', v(s.bilkoHostAddDocument, addDocument));
  ipcMain.handle('bilko-host:remove-document', v(s.bilkoHostRemoveDocument, removeDocument));
}

module.exports = {
  registerBilkoHostIpc,
  get,
  prepareBundle,
  addDocument,
  removeDocument,
  deriveSlug,
  bilkoHostDir,
  distDir,
};
