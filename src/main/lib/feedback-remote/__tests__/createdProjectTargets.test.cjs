/**
 * createdProjectTargets.test.cjs — a folder made by project_create
 * (createServiceProject) is a feedback target before it has any Claude
 * transcript, and openFeedbackSession accepts it as toCwd.
 *
 * Run: timeout 300 npx vitest run src/main/lib/feedback-remote/__tests__/createdProjectTargets.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const { listFeedbackTargets, openFeedbackSession } = require('../crossProjectFeedback.cjs');
const { createCreatedProjects } = require('../createdProjects.cjs');
const { createServiceProject } = require('../projectCreate.cjs');
const { readActiveIndex } = require('../../epic/epicMint.cjs');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'SM Test',
  GIT_AUTHOR_EMAIL: 'sm-test@example.invalid',
  GIT_COMMITTER_NAME: 'SM Test',
  GIT_COMMITTER_EMAIL: 'sm-test@example.invalid',
};

const tmpDirs = [];
const savedEnv = {};

beforeEach(() => {
  for (const [k, v] of Object.entries(GIT_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(async () => {
  for (const k of Object.keys(GIT_ENV)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

async function mkTemp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  config.addAllowedRoot(d);
  return fs.realpathSync(d);
}

/** Same shape as crossProjectFeedback.test.cjs's mkProject: an ops root plus
 *  the architect persona fixture ensureEpic needs to mint against. */
function addArchitectPersona(cwd) {
  const agentsDir = path.join(cwd, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'architect.md'), '---\nname: architect\nmodel: sonnet\n---\nFixture persona for tests.\n');
}

async function mkSmProject() {
  const cwd = await mkTemp('sm-cpt-from-');
  fs.mkdirSync(path.join(cwd, 'session-manager-operations'), { recursive: true });
  addArchitectPersona(cwd);
  return cwd;
}

async function setup() {
  const parent = await mkTemp('sm-cpt-parent-');
  const ledgerDir = await mkTemp('sm-cpt-ledger-');
  const projectsDir = await mkTemp('sm-cpt-projects-');
  const ledger = createCreatedProjects({ filePath: path.join(ledgerDir, 'created-projects.json') });
  const from = await mkSmProject();
  return { parent, ledger, projectsDir, from };
}

async function create({ parent, ledger, from }, name, externalRef) {
  const r = await createServiceProject(
    { name, parentDir: parent, fromCwd: from, externalRef },
    { ledger, appendAudit: () => {}, validatePath: (abs) => abs },
  );
  expect(r.ok).toBe(true);
  return r;
}

test('a folder made by createServiceProject is listed with an empty projectsDir', async () => {
  const s = await setup();
  const made = await create(s, 'kiln-build-one', 'kiln:idea-1');
  expect(fs.existsSync(path.join(made.cwd, '.git'))).toBe(true);
  expect(fs.existsSync(path.join(made.cwd, 'session-manager-operations'))).toBe(true);

  const res = await listFeedbackTargets({ projectsDir: s.projectsDir, createdProjects: s.ledger });
  expect(res.scanned).toBe(0);
  expect(res.truncated).toBe(0);
  expect(res.projects).toHaveLength(1);
  expect(res.projects[0].cwd).toBe(made.cwd);
  const createdAt = s.ledger.findByCwd(made.cwd).createdAt;
  expect(res.projects[0].lastActivity).toBe(new Date(createdAt).toISOString());
});

test('a deleted folder and a folder without an operations root are not listed', async () => {
  const s = await setup();
  const gone = await create(s, 'kiln-gone', 'kiln:idea-gone');
  const bare = await create(s, 'kiln-bare', 'kiln:idea-bare');
  const kept = await create(s, 'kiln-kept', 'kiln:idea-kept');
  await fsp.rm(gone.cwd, { recursive: true, force: true });
  await fsp.rm(path.join(bare.cwd, 'session-manager-operations'), { recursive: true, force: true });

  const { projects } = await listFeedbackTargets({ projectsDir: s.projectsDir, createdProjects: s.ledger });
  expect(projects.map((p) => p.cwd)).toEqual([kept.cwd]);
});

test('a ledger cwd that also has a transcript is listed once, at the later activity', async () => {
  const s = await setup();
  const made = await create(s, 'kiln-both', 'kiln:idea-both');
  const folder = path.join(s.projectsDir, 'enc-kiln-both');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 's.jsonl'), `${JSON.stringify({ cwd: made.cwd })}\n`);
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(folder, 's.jsonl'), later, later);
  fs.utimesSync(folder, later, later);

  const { projects } = await listFeedbackTargets({ projectsDir: s.projectsDir, createdProjects: s.ledger });
  expect(projects.map((p) => p.cwd)).toEqual([made.cwd]);
  expect(Date.parse(projects[0].lastActivity)).toBeGreaterThan(s.ledger.findByCwd(made.cwd).createdAt);
});

test('openFeedbackSession accepts a created project as toCwd and mints a proposed Epic there', async () => {
  const s = await setup();
  const made = await create(s, 'kiln-target', 'kiln:idea-target');
  addArchitectPersona(made.cwd);

  const r = await openFeedbackSession({
    toCwd: made.cwd,
    fromCwd: s.from,
    title: 'Build the idea',
    body: 'Open the Build Epic for this idea.',
    motivation: 'Kiln approved the idea and needs a project to build it in.',
    acceptanceCriteria: ['The Build Epic exists in the new project'],
  });
  expect(r.ok).toBe(true);
  expect(typeof r.epicId).toBe('string');
  expect(r.epicId.length).toBeGreaterThan(0);
  expect(r.status).toBe('proposed');
  expect(readActiveIndex(made.cwd).sessions[r.epicId].status).toBe('proposed');
});
