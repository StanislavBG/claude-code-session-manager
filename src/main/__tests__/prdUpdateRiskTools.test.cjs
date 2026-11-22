/**
 * prdUpdateRiskTools.test.cjs — scheduler_update_prd accepts `riskTools`
 * exactly as scheduler_create_prd does: the adminUpdatePrd zod schema keeps
 * the key, and updatePrd validates it with prdCreate.cjs's normalizeRiskTools
 * (the same validator createPrd uses), writes it normalized, refuses an
 * invalid rule without writing, and clears the key on an explicit [].
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdUpdateRiskTools.test.cjs
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
let prdFrontmatter;
let prdCreate;
let ipcSchemas;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-update-prd-risktools-home-'));
  process.env.HOME = tmpHome;

  scheduler = require('../scheduler.cjs');
  queueStore = require('../lib/scheduler/queueStore.cjs');
  config = require('../config.cjs');
  prdFrontmatter = require('../lib/prd/prdFrontmatter.cjs');
  prdCreate = require('../lib/prd/prdCreate.cjs');
  ipcSchemas = require('../ipcSchemas.cjs');

  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${scheduler.PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
  }
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function registerActiveProject(cwd) {
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

function makeFixtureProject(prefix) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registerActiveProject(cwd);
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

function writePrd(prdsDir, filename, cwd, extraFrontmatter = '') {
  fs.writeFileSync(
    path.join(prdsDir, filename),
    `---\ntitle: ${filename}\ncwd: ${cwd}\nestimateMinutes: 10\ncreatedVia: scheduler-api\n${extraFrontmatter}---\n\n# Goal\nDo the thing.\n`,
    'utf8',
  );
}

const RULES = ['mcp__bilko-host__publish_static_project', 'Bash(npm publish:*)'];

test('normalizeRiskTools is exported and matches createPrd\'s rules', () => {
  const { normalizeRiskTools } = prdCreate;
  expect(normalizeRiskTools([...RULES, RULES[0]])).toEqual({ ok: true, value: RULES });
  const notArray = normalizeRiskTools('Bash(ls)');
  expect(notArray.ok).toBe(false);
  expect(notArray.error).toMatch(/must be an array/);
  const bad = normalizeRiskTools(['not a rule!']);
  expect(bad.ok).toBe(false);
  expect(bad.error).toMatch(/is not a valid tool-risk rule/);
  const many = Array.from({ length: 21 }, (_, i) => `Bash(cmd${i})`);
  const tooMany = normalizeRiskTools(many);
  expect(tooMany.ok).toBe(false);
  expect(tooMany.error).toMatch(/maximum is 20/);
});

test('adminUpdatePrd.parse keeps frontmatter.riskTools', () => {
  const parsed = ipcSchemas.schemas.adminUpdatePrd.parse({ slug: '4-widget', frontmatter: { riskTools: RULES } });
  expect(parsed.frontmatter.riskTools).toEqual(RULES);
  const created = ipcSchemas.schemas.schedulerCreatePrd.shape.riskTools;
  const patched = ipcSchemas.schemas.adminUpdatePrd.shape.frontmatter.unwrap().shape.riskTools;
  expect(created.unwrap()).toBe(patched.unwrap());
});

test('updatePrd writes riskTools and parsePrdFile reads the same list back', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-update-risktools-valid-');
  try {
    writePrd(prdsDir, '4-widget.md', cwd);
    const result = await scheduler.remote.updatePrd({ slug: '4-widget', cwd, frontmatter: { riskTools: [...RULES, RULES[1]] } });
    expect(result.ok).toBe(true);
    const written = fs.readFileSync(path.join(prdsDir, '4-widget.md'), 'utf8');
    expect(prdFrontmatter.parsePrdFile(written).frontmatter.riskTools).toEqual(RULES);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('updatePrd refuses an invalid riskTools rule and leaves the file byte-identical', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-update-risktools-invalid-');
  try {
    writePrd(prdsDir, '4-widget.md', cwd, 'riskTools: [Bash(npm publish:*)]\n');
    const file = path.join(prdsDir, '4-widget.md');
    const before = fs.readFileSync(file);
    const result = await scheduler.remote.updatePrd({ slug: '4-widget', cwd, frontmatter: { riskTools: ['not a rule!'], title: 'changed' } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/is not a valid tool-risk rule/);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('updatePrd with riskTools: [] removes the key', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-update-risktools-clear-');
  try {
    writePrd(prdsDir, '4-widget.md', cwd, 'riskTools: [Bash(npm publish:*)]\n');
    const file = path.join(prdsDir, '4-widget.md');
    expect(prdFrontmatter.parsePrdFile(fs.readFileSync(file, 'utf8')).frontmatter.riskTools).toEqual(['Bash(npm publish:*)']);
    const result = await scheduler.remote.updatePrd({ slug: '4-widget', cwd, frontmatter: { riskTools: [] } });
    expect(result.ok).toBe(true);
    const written = fs.readFileSync(file, 'utf8');
    expect(written).not.toMatch(/riskTools/);
    expect(prdFrontmatter.parsePrdFile(written).frontmatter.riskTools).toBeUndefined();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
