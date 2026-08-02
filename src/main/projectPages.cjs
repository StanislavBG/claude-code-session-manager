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

const LENSES = ['home', 'marketing', 'feature', 'architecture'];

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
  if (htmlResults.some((r) => !r.exists)) {
    return { output: null };
  }

  const [home, marketing, feature, architecture] = htmlResults;
  const generatedAt = typeof manifestResult.data.generatedAt === 'string' ? manifestResult.data.generatedAt : null;
  if (!generatedAt) {
    return { output: null };
  }

  return {
    output: {
      home: home.text,
      marketing: marketing.text,
      feature: feature.text,
      architecture: architecture.text,
      generatedAt,
    },
  };
}

function registerProjectPagesIpc() {
  const { schemas: s, validated: v } = require('./ipcSchemas.cjs');
  ipcMain.handle('project-pages:get', v(s.projectPagesCwd, get));
}

module.exports = {
  registerProjectPagesIpc,
  get,
};
