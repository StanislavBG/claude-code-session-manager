/**
 * seedValidatorPersona.test.cjs — covers the `validator` persona's delivery
 * through seedAgentPersonas.cjs's existing "names not yet in `seeded`" path.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/seedValidatorPersona.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let realHome;
let seedAgentPersonas;

// config.cjs bakes os.homedir() into top-level consts at first require
// (allowedRoots/WRITE_PREFIXES, used by writeJsonSync) — must be purged
// alongside seedAgentPersonas.cjs so each test's tmpHome takes effect.
const MODULES_TO_RELOAD = ['../seedAgentPersonas.cjs', '../config.cjs'];

function purgeRequireCache() {
  for (const m of MODULES_TO_RELOAD) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
  }
}

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-validator-persona-test-'));
  process.env.HOME = tmpHome;
  delete process.env.SM_SEED_AGENT_PERSONAS_DISABLE;
  purgeRequireCache();
  ({ seedAgentPersonas } = require('../seedAgentPersonas.cjs'));
});

afterEach(() => {
  process.env.HOME = realHome;
  delete process.env.SM_SEED_AGENT_PERSONAS_DISABLE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  purgeRequireCache();
});

function agentsDir() {
  return path.join(tmpHome, '.claude', 'agents');
}

function markerPath() {
  return path.join(tmpHome, '.claude', 'session-manager', '.agent-personas-seeded');
}

function silentLogger() {
  return { log: () => {}, warn: () => {} };
}

const ALL_PERSONAS = ['architect', 'dev-lead', 'project-home-builder', 'validator', 'demo-video-builder', 'blender-artist', 'competitive-researcher', 'competitive-analyst'];
const seedSrc = (name) => path.join(__dirname, '..', '..', 'seed', 'agents', `${name}.md`);

test('a fresh homedir gets all four persona files', async () => {
  await seedAgentPersonas({ logger: silentLogger() });

  for (const name of ALL_PERSONAS) {
    const dest = path.join(agentsDir(), `${name}.md`);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toBe(fs.readFileSync(seedSrc(name), 'utf8'));
  }

  const marker = JSON.parse(fs.readFileSync(markerPath(), 'utf8'));
  expect(marker.seeded.sort()).toEqual([...ALL_PERSONAS].sort());
});

test('a homedir whose marker already lists the first three receives validator.md, and the other three files are byte-identical before and after', async () => {
  const mPath = markerPath();
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  fs.writeFileSync(
    mPath,
    JSON.stringify({ seeded: ['architect', 'dev-lead', 'project-home-builder'], attempts: 0, ts: '2026-01-01T00:00:00.000Z' })
  );
  fs.mkdirSync(agentsDir(), { recursive: true });
  const preExisting = {};
  for (const name of ['architect', 'dev-lead', 'project-home-builder']) {
    const content = `existing ${name} content\n`;
    fs.writeFileSync(path.join(agentsDir(), `${name}.md`), content);
    preExisting[name] = content;
  }

  expect(fs.existsSync(path.join(agentsDir(), 'validator.md'))).toBe(false);

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.readFileSync(path.join(agentsDir(), 'validator.md'), 'utf8')).toBe(fs.readFileSync(seedSrc('validator'), 'utf8'));

  // None of the three bodies matches anything this app has ever shipped
  // (they're hand-written placeholders), so the upgrade pass leaves all
  // three alone no matter what their seedVersion is — a missing stamp is no
  // longer by itself a reason to overwrite a file a person may have written.
  for (const name of ['architect', 'dev-lead', 'project-home-builder']) {
    expect(fs.readFileSync(path.join(agentsDir(), `${name}.md`), 'utf8')).toBe(preExisting[name]);
  }
  expect(fs.existsSync(path.join(agentsDir(), '.backup'))).toBe(false);
  expect(fs.existsSync(path.join(tmpHome, '.claude', 'session-manager', 'persona-backups'))).toBe(false);

  const marker = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  expect(marker.seeded.sort()).toEqual([...ALL_PERSONAS].sort());
});

// Validator jobs always run under `--json-schema` (scheduler.cjs passes
// VALIDATOR_VERDICT_SCHEMA when isValidator), so the body must teach the
// checked-JSON verdict contract, not the legacy sentinel lines.
test('the seeded validator body is under AGENT_BODY_CHAR_CAP and states the JSON verdict contract', () => {
  const { AGENT_BODY_CHAR_CAP } = require('../lib/claude/agentModelResolve.cjs');
  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const { MISS_KINDS } = require('../lib/scheduler/validatorVerdictSchema.cjs');
  const raw = fs.readFileSync(seedSrc('validator'), 'utf8');
  const { body } = splitFrontmatter(raw);
  const trimmed = body.trim();

  expect(trimmed.length).toBeLessThan(AGENT_BODY_CHAR_CAP);
  expect(trimmed).toContain('matches the verdict schema');
  expect(trimmed).toContain('print no sentinel lines');
  for (const key of ['`verdicts`', '`prd`', '`verdict`', '`reason`', '`criteria`', '`findings`', '`missKind`', '`schedulerVerdict`', '`failReason`']) {
    expect(trimmed).toContain(key);
  }
  expect(trimmed).toContain('`VERIFIED` or `REFUTED`');
  expect(trimmed).toContain('`schedulerVerdict`: `PASS`');
  for (const kind of MISS_KINDS) expect(trimmed).toContain(`\`${kind}\``);
  expect(trimmed).not.toContain('VALIDATION: <slug> VERIFIED');
  expect(trimmed).not.toContain('Do not touch:');
  expect(trimmed).not.toContain('Report explicitly:');
  expect(trimmed.endsWith('report them.')).toBe(true);
});

test('the seeded validator body resolves PRD files under SM_PROJECT_ROOT, not the job worktree', () => {
  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const raw = fs.readFileSync(seedSrc('validator'), 'utf8');
  const { body } = splitFrontmatter(raw);
  const trimmed = body.trim();

  expect(trimmed).toContain('$SM_PROJECT_ROOT/session-manager-operations/scheduler/epics/');
  expect(trimmed).toContain('prds-archived/');
  expect(trimmed).not.toContain('session-manager-operations/scheduler/epics/<epic>/prds/` while queued');
});

// The validator's tool list (Read, Grep, Glob, Bash) cannot load review
// skills, and each PRD's own run already did them — step 3 is a self-review,
// and step 4's record lists every finding so the architect gives each an outcome.
test('the seeded validator body asks for a self-review only and lists every finding', () => {
  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const raw = fs.readFileSync(seedSrc('validator'), 'utf8');
  const { body } = splitFrontmatter(raw);
  const trimmed = body.trim();

  expect(raw.length).toBeLessThan(6000);
  expect(trimmed).not.toContain('/code-review');
  expect(trimmed).not.toContain('/security-review');
  expect(trimmed).toContain('Self-review it for correctness, unsafe input handling, secrets, path traversal, and duplication of an existing helper.');
  expect(trimmed).toContain('never report their absence as a finding');
  expect(trimmed).toContain('List every finding, Minor included: the architect gives each one an outcome');
});

// Executor follow-ups travel as `Follow-up:` commit trailers; the validator
// reads full commit messages and records each trailer as a Minor finding.
test('the seeded validator reads full commit messages and turns Follow-up trailers into Minor findings', () => {
  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const raw = fs.readFileSync(seedSrc('validator'), 'utf8');
  const { fm, body } = splitFrontmatter(raw);

  expect(raw.length).toBeLessThanOrEqual(6000);
  expect(fm.seedVersion).toBe('14');
  expect(body).toContain("git log --format='%h %B' <base>..HEAD");
  expect(body).not.toContain('git log --oneline');
  expect(body).toContain('Every `Follow-up:` commit trailer is a Minor finding (missKind `other`) on its PRD; quote it.');
});

test('the seeded dev-lead puts follow-ups in a Follow-up commit trailer', () => {
  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const raw = fs.readFileSync(seedSrc('dev-lead'), 'utf8');
  const { fm, body } = splitFrontmatter(raw);

  expect(raw.length).toBeLessThanOrEqual(6000);
  expect(fm.seedVersion).toBe('9');
  expect(body).toContain('A follow-up goes in a `Follow-up: <one line>` commit trailer, never only in this report.');
});
