'use strict';

/**
 * projectPages.cjs — read-only backend for Project Home's Project Pages
 * display (PRD 932). Reads what the `project-home-builder` Epic's own
 * session writes directly with its Write tool
 * (`session-manager-operations/project-pages/output/*.html` + manifest.json)
 * — this module never writes anything, matching the corrected "not an
 * OWNERS namespace" storage/ownership note in
 * session-manager-operations/architecture/project-pages-pipeline.md and
 * session-manager-operations/project-pages/README.md. Structure mirrors
 * projectBrief.cjs's `get()`: validatePath first, config.cjs read helpers,
 * one ipcMain.handle registered from index.cjs's registerXHandlers() pattern.
 *
 * Shipped default (PRD "project-home-hosted-html-spec"): when a project has
 * never generated its own output, `get()` no longer returns the bare
 * `{ output: null }` empty-state signal — it falls back to a build-time
 * default `home.html` shipped with the app (`templates/`), returned with
 * `isDefault: true` and `generatedAt: null` so the renderer can label
 * provenance. That default is read from a fixed app-relative path, never
 * written into any project's own `session-manager-operations/` tree — this
 * module stays read-only.
 */

const { ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config.cjs');
const { opsPath } = require('./lib/opsOwnership.cjs');

function outputDir(cwd) {
  return opsPath(cwd, 'project-pages', 'output');
}

// Shipped build-time asset (see PRD "project-home-hosted-html-spec"'s
// default-document requirement) — a fixed app-relative path with no
// user-controlled segment, so it deliberately does NOT go through
// config.cjs's validatePath (whose allowedRoots is the user's home dir and
// would reject/mis-resolve a path under the app's own install directory,
// e.g. when installed via npx/global npm outside $HOME). Read once and
// cached in-process; this file never changes at runtime.
const DEFAULT_HOME_PATH = path.join(__dirname, 'templates', 'project-pages-default-home.html');
let cachedDefaultHomeHtml = null;
function readDefaultHomeHtml() {
  if (cachedDefaultHomeHtml === null) {
    cachedDefaultHomeHtml = fs.readFileSync(DEFAULT_HOME_PATH, 'utf8');
  }
  return cachedDefaultHomeHtml;
}
function defaultOutput() {
  return { home: readDefaultHomeHtml(), generatedAt: null, isDefault: true };
}

// The original 4 lenses stay required — their absence still means "no
// Project Pages generated yet" (now the shipped-default fallback rather
// than a bare null). 'brief' was added later (5th lens): a project that
// generated its output BEFORE 'brief'
// existed has home/marketing/feature/architecture.html but no brief.html, and
// that must keep reading as "has output" rather than suddenly regressing to
// the empty state for every pre-existing project. So brief.html is read
// tolerantly — present, its text is returned; absent, the field is simply
// omitted from the payload rather than failing the whole read.
const REQUIRED_LENSES = ['home', 'marketing', 'feature', 'architecture'];
const OPTIONAL_LENSES = ['brief'];
const LENSES = [...REQUIRED_LENSES, ...OPTIONAL_LENSES];

async function get({ cwd }) {
  const realCwd = config.validatePath(cwd);
  const dir = outputDir(realCwd);
  const manifestResult = await config.readJson(path.join(dir, 'manifest.json'));
  if (!manifestResult.exists || !manifestResult.data || manifestResult.parseError) {
    return { output: defaultOutput() };
  }

  const htmlResults = await Promise.all(
    LENSES.map((lens) => config.readText(path.join(dir, `${lens}.html`))),
  );
  const byLens = Object.fromEntries(LENSES.map((lens, i) => [lens, htmlResults[i]]));
  if (REQUIRED_LENSES.some((lens) => !byLens[lens].exists)) {
    return { output: defaultOutput() };
  }

  const generatedAt = typeof manifestResult.data.generatedAt === 'string' ? manifestResult.data.generatedAt : null;
  if (!generatedAt) {
    return { output: defaultOutput() };
  }

  const output = {
    home: byLens.home.text,
    marketing: byLens.marketing.text,
    feature: byLens.feature.text,
    architecture: byLens.architecture.text,
    generatedAt,
    isDefault: false,
  };
  if (byLens.brief.exists) {
    output.brief = byLens.brief.text;
  }

  return { output };
}

function registerProjectPagesIpc() {
  const { schemas: s, validated: v } = require('./ipcSchemas.cjs');
  ipcMain.handle('project-pages:get', v(s.projectPagesCwd, get));
}

module.exports = {
  registerProjectPagesIpc,
  get,
  DEFAULT_HOME_PATH,
  readDefaultHomeHtml,
};
