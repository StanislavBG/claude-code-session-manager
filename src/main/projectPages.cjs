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
 */

const { ipcMain } = require('electron');
const path = require('node:path');
const config = require('./config.cjs');

function outputDir(cwd) {
  return path.join(cwd, 'session-manager-operations', 'project-pages', 'output');
}

// The original 4 lenses stay required — their absence still means "no
// Project Pages generated yet" (the null empty-state signal). 'brief' was
// added later (5th lens): a project that generated its output BEFORE 'brief'
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
    return { output: null };
  }

  const htmlResults = await Promise.all(
    LENSES.map((lens) => config.readText(path.join(dir, `${lens}.html`))),
  );
  const byLens = Object.fromEntries(LENSES.map((lens, i) => [lens, htmlResults[i]]));
  if (REQUIRED_LENSES.some((lens) => !byLens[lens].exists)) {
    return { output: null };
  }

  const generatedAt = typeof manifestResult.data.generatedAt === 'string' ? manifestResult.data.generatedAt : null;
  if (!generatedAt) {
    return { output: null };
  }

  const output = {
    home: byLens.home.text,
    marketing: byLens.marketing.text,
    feature: byLens.feature.text,
    architecture: byLens.architecture.text,
    generatedAt,
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
};
