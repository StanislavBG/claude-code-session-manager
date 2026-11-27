/**
 * prdUpdateSandboxWarnings.test.cjs — updatePrd returns the same sandboxWarnings advisory createPrd does.
 * Run: timeout 120 npx vitest run src/main/__tests__/prdUpdateSandboxWarnings.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let queueStore;
let config;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-update-prd-sandbox-home-'));
  process.env.HOME = tmpHome;
  scheduler = require('../scheduler.cjs');
  queueStore = require('../lib/scheduler/queueStore.cjs');
  config = require('../config.cjs');
  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) throw new Error('refusing to run: PRDS_DIR not under temp HOME');
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function makeFixtureProject(prefix) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
  config.addAllowedRoot(cwd);
  const opsRoot = path.join(cwd, 'session-manager-operations');
  const prdsDir = path.join(opsRoot, 'scheduler', 'epics', 'test-epic-1', 'prds');
  const stateDir = path.join(opsRoot, 'scheduler', 'state');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs: [] }, null, 2), 'utf8');
  queueStore.bustCwdCache();
  return { cwd, prdsDir };
}

function writePrd(prdsDir, cwd, filesList) {
  fs.writeFileSync(
    path.join(prdsDir, '4-widget.md'),
    `---\ntitle: w\ncwd: ${cwd}\nestimateMinutes: 10\ncreatedVia: scheduler-api\n---\n\n# Goal\nDo the thing.\n\n# Files\n\n${filesList.map((f) => `- ${f}`).join('\n')}\n`,
    'utf8',
  );
}

const sandboxOnly = (r) => (r.warnings ?? []).filter((w) => /\.claude/.test(w));

test('files patch listing a protected .claude path warns naming it', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-upd-sbx-a-');
  try {
    writePrd(prdsDir, cwd, ['src/a.cjs']);
    const r = await scheduler.remote.updatePrd({ slug: '4-widget', cwd, files: ['.claude/skills/x/SKILL.md'] });
    expect(r.ok).toBe(true);
    expect(sandboxOnly(r).join('\n')).toContain('.claude/skills/x/SKILL.md');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('files patch with plain paths adds no sandbox warning', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-upd-sbx-b-');
  try {
    writePrd(prdsDir, cwd, ['src/a.cjs']);
    const r = await scheduler.remote.updatePrd({ slug: '4-widget', cwd, files: ['src/b.cjs'] });
    expect(r.ok).toBe(true);
    expect(sandboxOnly(r)).toEqual([]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('body-only update of a PRD already listing a protected path warns', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-upd-sbx-c-');
  try {
    writePrd(prdsDir, cwd, ['.claude/skills/portfolio/SKILL.md']);
    const body = '\n# Goal\nChanged goal.\n\n# Files\n\n- .claude/skills/portfolio/SKILL.md\n';
    const r = await scheduler.remote.updatePrd({ slug: '4-widget', cwd, body });
    expect(r.ok).toBe(true);
    expect(sandboxOnly(r).join('\n')).toContain('.claude/skills/portfolio/SKILL.md');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
