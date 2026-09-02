/**
 * projectHomeAdminRoutes.cjs — the app-side half of "the generating session
 * needs zero repo knowledge to build a Project Home page" (PRD:
 * project-home-admin-routes). Before this file, the project-home-builder
 * Epic had to know session-manager's own repo layout (where the catalog
 * lives, how to invoke the validator/renderer CLIs, which build step to run
 * first) — which is exactly why generation silently hung on a foreign
 * machine with no repo checked out. These four routes make the app itself
 * the authority on paths/schema/catalog/rendering, reusing the shipped
 * assets PRD 1088 put in the npm tarball (scripts/render-project-pages/dist/
 * renderer.cjs, scripts/project-pages-logic/dist/logic.cjs,
 * src/main/templates/project-pages-catalog.json,
 * src/main/templates/project-pages-pipeline.md) rather than reimplementing
 * any of them.
 *
 * Registered against the same injected localAdminHttp.cjs transport as
 * prdAdminRoutes.cjs — see that file's header for the transport contract
 * (`registerRoute(method, url, handler)`, handlers get
 * `(req, res, query: URLSearchParams)`).
 *
 * The MCP tool surface that calls these routes is the NEXT PRD in this
 * chain — this file only exposes the HTTP contract.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readBody, sendJson } = require('./localAdminHttp.cjs');
const { resolveProjectContext } = require('./projectRootResolve.cjs');
const { opsPath, OPS_ROOT_DIR } = require('./opsOwnership.cjs');
const { PROJECT_PAGE_SUMMARY_JSON_SCHEMA, PROJECT_PAGE_PICKS_JSON_SCHEMA } = require('./projectPageSummarySchema.cjs');
const config = require('../config.cjs');
const { schemas } = require('../ipcSchemas.cjs');

const LENSES = ['home', 'marketing', 'feature', 'architecture', 'brief'];

// Shipped, build-time assets — fixed app-relative paths, read once and
// cached in-process, same pattern as projectPages.cjs's
// cachedDefaultHomeHtml (this file never changes at runtime; a repo edit
// requires an app restart to pick up during dev, same as that module).
const CATALOG_PATH = path.join(__dirname, '..', 'templates', 'project-pages-catalog.json');
const SPEC_PATH = path.join(__dirname, '..', 'templates', 'project-pages-pipeline.md');
const RENDERER_BUNDLE_PATH = path.join(__dirname, '..', '..', '..', 'scripts', 'render-project-pages', 'dist', 'renderer.cjs');
const LOGIC_BUNDLE_PATH = path.join(__dirname, '..', '..', '..', 'scripts', 'project-pages-logic', 'dist', 'logic.cjs');

let cachedCatalog = null;
function loadCatalog() {
  if (!cachedCatalog) {
    const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Drop $comment — it names the repo-relative source files the catalog
    // was generated from (build-tooling provenance), which would violate
    // this route's "never point the caller at a repo-relative path"
    // contract if echoed back verbatim.
    cachedCatalog = { lenses: parsed.lenses };
  }
  return cachedCatalog;
}

let cachedSpecText = null;
function loadSpecText() {
  if (cachedSpecText === null) {
    cachedSpecText = fs.readFileSync(SPEC_PATH, 'utf8');
  }
  return cachedSpecText;
}

let cachedRenderer = null;
function loadRenderer() {
  if (!cachedRenderer) {
    ({ renderProjectPages: cachedRenderer } = require(RENDERER_BUNDLE_PATH));
  }
  return cachedRenderer;
}

let cachedValidator = null;
function loadValidator() {
  if (!cachedValidator) {
    ({ validateProjectPageSummary: cachedValidator } = require(LOGIC_BUNDLE_PATH));
  }
  return cachedValidator;
}

/** Same definition crossProjectFeedback.cjs uses for "is this a Session
 * Manager project": it already has an operations root. Deliberately does
 * NOT require project-pages/ specifically to exist — a project that has
 * never generated a Project Home page yet is still a Session Manager
 * project (see the "no output dir yet" edge case on /status and /render). */
function isSessionManagerProject(cwd) {
  try {
    return fs.statSync(path.join(cwd, OPS_ROOT_DIR)).isDirectory();
  } catch {
    return false;
  }
}

function projectPagesPaths(cwd) {
  const dir = opsPath(cwd, 'project-pages');
  return {
    summaryPath: path.join(dir, 'summary.json'),
    picksPath: path.join(dir, 'picks.json'),
    outputDir: path.join(dir, 'output'),
  };
}

/**
 * Resolve+validate a caller-supplied cwd into a real Session Manager
 * project root. Never throws — returns a structured verdict so every route
 * can turn a bad cwd into a JSON error instead of an unhandled throw (this
 * PRD's edge-case requirement).
 *
 * Deliberately does NOT call config.addAllowedRoot here — that widens
 * config.cjs's process-lifetime write boundary and belongs only on an
 * actual write path (the render route calls it itself, right before
 * writing), not on every GET this function also gates.
 */
function resolveCwd(rawCwd) {
  if (!rawCwd || typeof rawCwd !== 'string') {
    return { ok: false, status: 400, error: 'cwd is required' };
  }
  if (!path.isAbsolute(rawCwd)) {
    return { ok: false, status: 400, error: 'cwd must be an absolute path' };
  }
  // Normalizes a worktree/ops-internal cwd to its real project root (see
  // projectRootResolve.cjs's header) so a headless job running inside an
  // Epic's worktree still targets the right project.
  const resolved = resolveProjectContext({ cwd: rawCwd });
  const candidate = resolved.cwd || rawCwd;
  let realCwd;
  try {
    realCwd = config.validatePath(candidate);
  } catch (e) {
    return { ok: false, status: 400, error: `cwd rejected: ${e?.message ?? 'outside allowed roots'}` };
  }
  if (!isSessionManagerProject(realCwd)) {
    return {
      ok: false,
      status: 400,
      error: `${realCwd} is not a Session Manager project — it has no ${OPS_ROOT_DIR}/ directory`,
    };
  }
  return { ok: true, cwd: realCwd };
}

/** Each validateProjectPageSummary error string is "<field.path> must ...".
 * Split it into { field, message } for the route's documented response
 * shape — the validator itself only returns flat strings. */
function toFieldErrors(errors) {
  return errors.map((message) => {
    const m = /^([\w.]+)\s/.exec(message);
    return { field: m ? m[1] : 'summary', message };
  });
}

/**
 * Structural check for ProjectPagePicks (lensId -> slotId -> variantId) —
 * the shipped validator only covers `summary`, so this is the one guard
 * against handing the renderer bundle a shape it doesn't expect. Returns
 * "<field> must ..." strings in the same format toFieldErrors expects, so
 * both routes can share one error-shape.
 */
function validatePicksShape(picks) {
  if (picks === null || typeof picks !== 'object' || Array.isArray(picks)) {
    return ['picks must be an object'];
  }
  const errors = [];
  for (const [lensId, slotMap] of Object.entries(picks)) {
    if (slotMap === null || typeof slotMap !== 'object' || Array.isArray(slotMap)) {
      errors.push(`picks.${lensId} must be an object`);
      continue;
    }
    for (const [slotId, variantId] of Object.entries(slotMap)) {
      if (typeof variantId !== 'string' || variantId.length === 0) {
        errors.push(`picks.${lensId}.${slotId} must be a non-empty string`);
      }
    }
  }
  return errors;
}

/** Shared readBody -> JSON.parse -> zod-schema.parse pipeline for the two
 * POST routes — collapses the 3-step try/catch chain that was previously
 * duplicated in both handlers into one call. Returns either
 * { ok: true, input } or { ok: false, status, error, details }. */
async function parseJsonBody(req, schema) {
  const raw = await readBody(req);
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, status: 400, error: 'invalid JSON body' };
  }
  try {
    return { ok: true, input: schema.parse(body) };
  } catch (e) {
    return { ok: false, status: 400, error: 'invalid payload', details: e?.issues ?? e?.message };
  }
}

function buildProtocol() {
  return [
    'Call GET /admin/project-home/status?cwd=<abs> to see what already exists for this project (summary.json, picks.json, and any prior output).',
    'Compose a ProjectPageSummary object matching the schema in this response\'s "summarySchema" field. Never fabricate content — every field must trace to something concrete about this project (an Epic goal, a source file/dir, a convention, a git log entry). Omit "brief" entirely if this project has no generated brief.json yet; omit "quotes" entries rather than inventing a testimonial.',
    'For each lens in this response\'s "catalog.lenses", and for each of that lens\'s slots, pick exactly one variant id by judging the candidate variants\' "note" text against the summary content you composed. Assemble the picks into a ProjectPagePicks object (lensId -> slotId -> variantId) matching "picksSchema".',
    'POST /admin/project-home/validate-summary with {cwd, summary}. If "valid" is false, fix every listed {field, message} error and re-validate before continuing.',
    'POST /admin/project-home/render with {cwd, summary, picks}. This re-validates the summary server-side (rejecting with no writes on failure), renders all 5 lenses, and writes summary.json, picks.json, and output/{home,marketing,feature,architecture,brief}.html + output/manifest.json at the absolute paths in this response\'s "paths" field.',
    'Optionally call GET /admin/project-home/status again to confirm the new files landed and to read manifest.json\'s generatedAt.',
  ];
}

function registerAdminRoute(adminHttp) {
  // GET /admin/project-home/contract?cwd=<abs> — the self-sufficient
  // contract: protocol, schema, catalog, absolute paths, spec. Nothing in
  // this response should require the caller to read a repo-relative path.
  adminHttp.registerRoute('GET', '/admin/project-home/contract', async (req, res, query) => {
    let input;
    try {
      input = schemas.projectHomeAdminCwdQuery.parse(Object.fromEntries(query ?? []));
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid query', details: e?.issues ?? e?.message });
      return;
    }
    const resolved = resolveCwd(input.cwd);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { ok: false, error: resolved.error });
      return;
    }
    // projectPagesPaths()->opsPath() can throw for a cwd resolveCwd accepted
    // but opsPath's own (separate) ephemeral-root check refuses — keep this
    // route's "never an unhandled throw" contract even on that edge.
    try {
      const { summaryPath, picksPath, outputDir } = projectPagesPaths(resolved.cwd);
      sendJson(res, 200, {
        ok: true,
        protocol: buildProtocol(),
        summarySchema: PROJECT_PAGE_SUMMARY_JSON_SCHEMA,
        picksSchema: PROJECT_PAGE_PICKS_JSON_SCHEMA,
        catalog: loadCatalog(),
        paths: { summaryPath, picksPath, outputDir },
        spec: { text: loadSpecText(), path: SPEC_PATH },
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e?.message ?? 'failed to resolve project-pages paths' });
    }
  });

  // POST /admin/project-home/validate-summary {cwd, summary}
  adminHttp.registerRoute('POST', '/admin/project-home/validate-summary', async (req, res) => {
    const parsed = await parseJsonBody(req, schemas.projectHomeAdminValidateSummaryBody);
    if (!parsed.ok) {
      sendJson(res, parsed.status, { ok: false, error: parsed.error, details: parsed.details });
      return;
    }
    const { input } = parsed;
    const resolved = resolveCwd(input.cwd);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { ok: false, error: resolved.error });
      return;
    }
    const validateProjectPageSummary = loadValidator();
    const result = validateProjectPageSummary(input.summary);
    if (!result.ok) {
      sendJson(res, 200, { ok: true, valid: false, errors: toFieldErrors(result.errors) });
      return;
    }
    sendJson(res, 200, { ok: true, valid: true, errors: [] });
  });

  // POST /admin/project-home/render {cwd, summary, picks}
  adminHttp.registerRoute('POST', '/admin/project-home/render', async (req, res) => {
    const parsed = await parseJsonBody(req, schemas.projectHomeAdminRenderBody);
    if (!parsed.ok) {
      sendJson(res, parsed.status, { ok: false, error: parsed.error, details: parsed.details });
      return;
    }
    const { input } = parsed;
    const resolved = resolveCwd(input.cwd);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { ok: false, error: resolved.error });
      return;
    }
    const validateProjectPageSummary = loadValidator();
    const validation = validateProjectPageSummary(input.summary);
    const picksErrors = validatePicksShape(input.picks);
    if (!validation.ok || picksErrors.length > 0) {
      sendJson(res, 400, {
        ok: false,
        valid: false,
        errors: [...toFieldErrors(validation.ok ? [] : validation.errors), ...toFieldErrors(picksErrors)],
      });
      return;
    }

    // Only a route that is actually about to write registers the cwd as a
    // write-allowed root — see resolveCwd's header for why this must not
    // happen on the GET routes above.
    config.addAllowedRoot(resolved.cwd);
    try {
      const result = await serializedPerCwd(resolved.cwd, () => doRender(resolved.cwd, input.summary, input.picks));
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e?.message ?? 'render failed' });
    }
  });

  // GET /admin/project-home/status?cwd=<abs>
  adminHttp.registerRoute('GET', '/admin/project-home/status', async (req, res, query) => {
    let input;
    try {
      input = schemas.projectHomeAdminCwdQuery.parse(Object.fromEntries(query ?? []));
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid query', details: e?.issues ?? e?.message });
      return;
    }
    const resolved = resolveCwd(input.cwd);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { ok: false, error: resolved.error });
      return;
    }
    try {
      const status = await getStatus(resolved.cwd);
      sendJson(res, 200, { ok: true, ...status });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e?.message ?? 'failed to read project-pages status' });
    }
  });
}

// Per-cwd in-process promise chain — the render route's only concurrency
// guard. Sufficient because this admin HTTP server is a single Node
// process (Electron main) with no worker pool for these routes; a second
// concurrent render for the SAME cwd simply waits for the first to finish
// writing before it starts, so output/ is never observed half-written by
// two overlapping /render calls (it does NOT defend against a
// project-home-builder Epic's own separate Write-tool calls racing this
// route from a different OS process — see project-pages/README.md's
// concurrency section). Entries are evicted once their chain settles so
// this Map doesn't grow for the life of the process across many cwds.
const renderChains = new Map();
function serializedPerCwd(cwd, fn) {
  const prev = renderChains.get(cwd) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const settled = next.catch(() => {});
  renderChains.set(cwd, settled);
  settled.finally(() => {
    if (renderChains.get(cwd) === settled) renderChains.delete(cwd);
  });
  return next;
}

async function doRender(cwd, summary, picks) {
  const renderProjectPages = loadRenderer();
  const pages = renderProjectPages(summary, picks);
  const generatedAt = new Date().toISOString();
  const { summaryPath, picksPath, outputDir } = projectPagesPaths(cwd);

  // The 5 lens files plus summary.json/picks.json have no ordering
  // dependency on each other — only manifest.json's presence is the
  // "generation complete" signal getStatus() relies on, so it's written
  // last, after everything else has landed.
  const lensWrites = LENSES.map((lens) => {
    const lensPath = path.join(outputDir, `${lens}.html`);
    return config.writeTextAtomic(lensPath, pages[lens], { writer: 'project-home' }).then(() => lensPath);
  });
  const [, , ...lensPaths] = await Promise.all([
    config.writeJson(summaryPath, summary, { writer: 'project-home' }).then(() => summaryPath),
    config.writeJson(picksPath, picks, { writer: 'project-home' }).then(() => picksPath),
    ...lensWrites,
  ]);
  const manifestPath = path.join(outputDir, 'manifest.json');
  await config.writeJson(manifestPath, { generatedAt }, { writer: 'project-home' });

  return { filesWritten: [summaryPath, picksPath, ...lensPaths, manifestPath], generatedAt };
}

async function getStatus(cwd) {
  const { summaryPath, picksPath, outputDir } = projectPagesPaths(cwd);
  const [summaryRes, picksRes, manifestRes, ...lensRes] = await Promise.all([
    config.readJson(summaryPath),
    config.readJson(picksPath),
    config.readJson(path.join(outputDir, 'manifest.json')),
    ...LENSES.map((lens) => config.readText(path.join(outputDir, `${lens}.html`))),
  ]);

  const output = {};
  LENSES.forEach((lens, i) => {
    const r = lensRes[i];
    output[lens] = { exists: r.exists, mtimeMs: r.exists ? r.mtimeMs : null };
  });

  return {
    summary: { exists: summaryRes.exists, mtimeMs: summaryRes.exists ? summaryRes.mtimeMs : null },
    picks: { exists: picksRes.exists, mtimeMs: picksRes.exists ? picksRes.mtimeMs : null },
    output,
    manifest: {
      exists: manifestRes.exists,
      generatedAt: manifestRes.exists && manifestRes.data ? (manifestRes.data.generatedAt ?? null) : null,
    },
  };
}

module.exports = { registerAdminRoute };
