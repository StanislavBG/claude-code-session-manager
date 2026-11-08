'use strict';

/**
 * matrixStore.cjs — the one sanctioned writer of the Competitor matrix state
 * (writer 'project-home', namespace project-pages). writeMatrix() validates,
 * archives the previous valid matrix.json into history/ (newest HISTORY_KEEP
 * kept), writes matrix.json + matrix.schema.json, and refreshes the HTML
 * snapshot as the Pages library entry knowledge/competitive-matrix.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('../../config.cjs');
const { opsPath, assertOpsWrite } = require('../opsOwnership.cjs');
const { validateMatrix, matrixJsonSchema, matrixPaths } = require('./competitiveMatrix.cjs');
const { renderMatrixHtml } = require('./matrixHtml.cjs');

const WRITER = 'project-home';
const HISTORY_KEEP = 50;
const PAGE_ID = 'competitive-matrix';
const HISTORY_NAME_RE = /^\d{8}T\d{6}Z\.json$/;

/** '2026-11-08T12:00:00.000Z' -> '20261108T120000Z'. */
function historyStamp(iso) {
  const d = new Date(iso);
  return d.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
}

function write(abs, text) {
  return config.writeTextAtomic(abs, text, { writer: WRITER });
}

/** Copy the current matrix.json into history/ if it is a valid matrix; -> path or null. */
async function archivePrevious(paths) {
  let buf;
  try {
    buf = await fsp.readFile(paths.matrix);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  let value;
  try {
    value = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  const v = validateMatrix(value);
  if (!v.ok) return null;
  const dest = path.join(paths.history, `${historyStamp(v.matrix.updatedAt)}.json`);
  await write(dest, buf.toString('utf8'));
  return dest;
}

/** Remove all but the newest HISTORY_KEEP history files, through the same checks renameMigrated uses. */
async function pruneHistory(historyDir) {
  let names;
  try {
    names = await fsp.readdir(historyDir);
  } catch (e) {
    if (e && e.code === 'ENOENT') return;
    throw e;
  }
  const files = names.filter((n) => HISTORY_NAME_RE.test(n)).sort();
  for (const name of files.slice(0, Math.max(0, files.length - HISTORY_KEEP))) {
    const real = config.validatePath(path.join(historyDir, name));
    config.validateWrite(real);
    assertOpsWrite(real, WRITER);
    await fsp.unlink(real);
  }
}

/**
 * writeMatrix(realCwd, value, { model, renderHtml }) ->
 *   { ok: true, path, htmlPath, historyPath } | { ok: false, error }.
 * Nothing is written when validation fails — of the matrix, or of the rendered
 * HTML snapshot against validateHomeHtml (fail closed). renderHtml is a test seam.
 */
async function writeMatrix(realCwd, value, { model = '', renderHtml = renderMatrixHtml } = {}) {
  const v = validateMatrix(value);
  if (!v.ok) return { ok: false, error: v.error };
  const paths = matrixPaths(realCwd);
  if (!paths) return { ok: false, error: 'not a project' };
  const matrix = v.matrix;
  const { schemas } = require('../../ipcSchemas.cjs');
  const topic = `${matrix.product.name} vs ${matrix.competitors.map((c) => c.name).join(', ')}`.slice(0, 120);
  const meta = schemas.projectPageMeta.parse({
    id: PAGE_ID,
    title: 'Competitor matrix',
    topic,
    createdAt: new Date().toISOString(),
    model: String(model || '').slice(0, 60),
  });
  const html = renderHtml(matrix);
  // Lazy: projectHomeAdminRoutes.cjs requires this module (circular at top level).
  const { validateHomeHtml } = require('../feedback-remote/projectHomeAdminRoutes.cjs');
  const rejection = validateHomeHtml(html);
  if (rejection) return { ok: false, error: `matrix page rejected: ${rejection}` };

  const historyPath = await archivePrevious(paths);
  if (historyPath) await pruneHistory(paths.history);

  await write(paths.matrix, JSON.stringify(value, null, 2) + '\n');
  await write(paths.schema, JSON.stringify(matrixJsonSchema(), null, 2) + '\n');
  const pageDir = opsPath(realCwd, 'project-pages', 'knowledge', PAGE_ID);
  const htmlPath = path.join(pageDir, 'index.html');
  await write(htmlPath, html);
  await write(path.join(pageDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  return { ok: true, path: paths.matrix, htmlPath, historyPath };
}

module.exports = { writeMatrix, HISTORY_KEEP, PAGE_ID };
