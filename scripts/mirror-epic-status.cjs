#!/usr/bin/env node
'use strict';

/**
 * mirror-epic-status.cjs — one-shot back-fill of the status mirror
 * (epicStatusMirror.cjs) onto EXISTING prompt-sessions/<id>.json files, from
 * the CURRENT active-index.json. Every write path added after this PRD keeps
 * the mirror current going forward; this script is only for Epic files that
 * predate that change.
 *
 * For each row in active-index.json's `sessions`, back-fills that row's
 * full PromptSession shape onto its file. For every OTHER *.json file under
 * prompt-sessions/ (excluding active-index.json) that has no row in the
 * index and is NOT tombstoned, stamps `status: 'unknown'` rather than
 * inventing a real lifecycle state — the domain model has exactly three
 * states (proposed/active/completed) and this script cannot know which one
 * applied to a file the index no longer references (it may be a completed
 * archive from before this PRD, which already carries `session.status` and
 * `archivedAt` at the top level in newer archives, or a genuinely stranded
 * file). A completed archive already has `archivedAt` set at its top level —
 * this script leaves that alone (a file with archivedAt is treated as
 * already carrying the mirror, not 'unknown').
 *
 * Default dry-run: prints every file it WOULD touch. Pass --apply to write.
 *
 * Usage: node scripts/mirror-epic-status.cjs <project-cwd> [--apply]
 */

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const applyFlag = args.includes('--apply');
const targetCwd = args.find((a) => !a.startsWith('--'));

if (!targetCwd) {
  process.stderr.write('usage: mirror-epic-status.cjs <project-cwd> [--apply]\n');
  process.exit(1);
}

const cwd = path.resolve(targetCwd);
const dir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
const indexPath = path.join(dir, 'active-index.json');

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const index = readJsonSafe(indexPath) || { sessions: {}, tombstones: {} };
const sessions = index.sessions && typeof index.sessions === 'object' ? index.sessions : {};
const tombstones = index.tombstones && typeof index.tombstones === 'object' ? index.tombstones : {};

let files = [];
try {
  files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'active-index.json');
} catch {
  process.stdout.write(`no prompt-sessions/ directory at ${dir} — nothing to do\n`);
  process.exit(0);
}

const planned = []; // { file, action, reason }

function writeMirror(file, merged) {
  const full = path.join(dir, file);
  const tmp = `${full}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n');
  fs.renameSync(tmp, full);
}

for (const [id, session] of Object.entries(sessions)) {
  const file = `${id}.json`;
  const full = path.join(dir, file);
  const existing = readJsonSafe(full) || {};
  const merged = {
    ...existing,
    ...session,
    id,
    cwd: session.cwd || cwd,
    status: session.status,
    archivedAt: existing.archivedAt ?? null,
    indexedAt: new Date().toISOString(),
  };
  planned.push({ file, action: 'mirror-from-index-row', reason: `status='${session.status}'` });
  if (applyFlag) writeMirror(file, merged);
}

const indexedIds = new Set(Object.keys(sessions));
for (const file of files) {
  const id = file.slice(0, -'.json'.length);
  if (indexedIds.has(id)) continue;
  const full = path.join(dir, file);
  const existing = readJsonSafe(full);
  if (!existing || typeof existing !== 'object') {
    planned.push({ file, action: 'skip', reason: 'unreadable — left untouched' });
    continue;
  }
  if (existing.archivedAt || existing.status) {
    planned.push({ file, action: 'skip', reason: 'already carries a status/archivedAt mirror' });
    continue;
  }
  if (Object.prototype.hasOwnProperty.call(tombstones, id)) {
    planned.push({ file, action: 'skip', reason: 'tombstoned — never mirrored' });
    continue;
  }
  const merged = {
    ...existing,
    id,
    cwd: existing.cwd || cwd,
    status: 'unknown',
    archivedAt: existing.archivedAt ?? null,
    indexedAt: new Date().toISOString(),
  };
  planned.push({ file, action: 'mirror-as-unknown', reason: 'absent from index, not tombstoned — status unknowable' });
  if (applyFlag) writeMirror(file, merged);
}

process.stdout.write(JSON.stringify({
  cwd,
  dryRun: !applyFlag,
  totalFiles: files.length,
  planned,
}, null, 2) + '\n');
