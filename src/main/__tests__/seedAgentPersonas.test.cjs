/**
 * seedAgentPersonas.test.cjs — unit tests for src/main/seedAgentPersonas.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/seedAgentPersonas.test.cjs
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-agent-personas-test-'));
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

test('fresh seed writes every persona file', async () => {
  await seedAgentPersonas({ logger: silentLogger() });

  for (const name of ALL_PERSONAS) {
    const dest = path.join(agentsDir(), `${name}.md`);
    expect(fs.existsSync(dest)).toBe(true);
    const bundled = fs.readFileSync(path.join(__dirname, '..', '..', 'seed', 'agents', `${name}.md`), 'utf8');
    expect(fs.readFileSync(dest, 'utf8')).toBe(bundled);
  }

  const marker = JSON.parse(fs.readFileSync(markerPath(), 'utf8'));
  expect(marker.seeded.sort()).toEqual([...ALL_PERSONAS].sort());
});

test('a pre-existing persona file is left byte-identical', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  const architect = path.join(agentsDir(), 'architect.md');
  const customContent = '# My custom architect\nnever overwrite me\n';
  fs.writeFileSync(architect, customContent);

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.readFileSync(architect, 'utf8')).toBe(customContent);
  // dev-lead and project-home-builder had no pre-existing file, so they should still be seeded.
  expect(fs.existsSync(path.join(agentsDir(), 'dev-lead.md'))).toBe(true);
  expect(fs.existsSync(path.join(agentsDir(), 'project-home-builder.md'))).toBe(true);
});

test('a machine already fully seeded under the old done:true marker only picks up a newly added persona', async () => {
  const mPath = markerPath();
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  // Legacy marker shape from before the seeded-set change — no `seeded` array.
  fs.writeFileSync(mPath, JSON.stringify({ done: true, attempts: 1, ts: '2026-01-01T00:00:00.000Z' }));
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), 'architect.md'), 'old architect content\n');
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), 'old dev-lead content\n');

  await seedAgentPersonas({ logger: silentLogger() });

  // Neither body matches anything this app has ever shipped (they're
  // hand-written placeholders), so the upgrade pass leaves both alone no
  // matter what their seedVersion is — a missing stamp is no longer by
  // itself a reason to overwrite a file a person may have written.
  expect(fs.readFileSync(path.join(agentsDir(), 'architect.md'), 'utf8')).toBe('old architect content\n');
  expect(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8')).toBe('old dev-lead content\n');
  expect(fs.existsSync(path.join(agentsDir(), '.backup'))).toBe(false);
  expect(fs.existsSync(path.join(tmpHome, '.claude', 'session-manager', 'persona-backups'))).toBe(false);
  // ...but the newly added persona is still delivered.
  expect(fs.existsSync(path.join(agentsDir(), 'project-home-builder.md'))).toBe(true);

  const marker = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  expect(marker.seeded.sort()).toEqual([...ALL_PERSONAS].sort());
});

test('a machine already seeded under the new seeded-set marker picks up a newly added persona', async () => {
  const mPath = markerPath();
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  fs.writeFileSync(mPath, JSON.stringify({ seeded: ['architect', 'dev-lead'], attempts: 0, ts: '2026-01-01T00:00:00.000Z' }));

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.existsSync(path.join(agentsDir(), 'project-home-builder.md'))).toBe(true);
  const marker = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  expect(marker.seeded.sort()).toEqual([...ALL_PERSONAS].sort());
});

test('a machine with every known persona already in the seeded set short-circuits without touching agents dir', async () => {
  const mPath = markerPath();
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  fs.writeFileSync(mPath, JSON.stringify({ seeded: ALL_PERSONAS, attempts: 0, ts: '2026-01-01T00:00:00.000Z' }));

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.existsSync(agentsDir())).toBe(false);
});

test('a corrupt/unparseable marker file still seeds correctly', async () => {
  const mPath = markerPath();
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  fs.writeFileSync(mPath, '{ not valid json');

  await seedAgentPersonas({ logger: silentLogger() });

  for (const name of ALL_PERSONAS) {
    expect(fs.existsSync(path.join(agentsDir(), `${name}.md`))).toBe(true);
  }
});

test('the bundled project-home-builder and demo-video-builder personas contain no session-manager-repo paths', () => {
  const forbidden = [
    'session-manager-operations/architecture/',
    '.claude/agents/',
    'session-manager-operations/design-mocks/',
    'scripts/',
    'npm run build:project-pages',
  ];
  for (const name of ['project-home-builder', 'demo-video-builder']) {
    const content = fs.readFileSync(
      path.join(__dirname, '..', '..', 'seed', 'agents', `${name}.md`),
      'utf8'
    );
    for (const substr of forbidden) {
      expect(content).not.toContain(substr);
    }
  }
});

test('seeded dev-lead persona pins an executor-tier model', () => {
  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'seed', 'agents', 'dev-lead.md'), 'utf8');
  const { fm } = splitFrontmatter(raw);
  expect(fm.model).toBe('sonnet');
});

test('seeded dev-lead body fits AGENT_BODY_CHAR_CAP and carries the run contract', () => {
  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const { AGENT_BODY_CHAR_CAP } = require('../lib/claude/agentModelResolve.cjs');
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'seed', 'agents', 'dev-lead.md'), 'utf8');
  const { body } = splitFrontmatter(raw);
  const trimmed = body.trim();
  expect(trimmed.length).toBeLessThan(AGENT_BODY_CHAR_CAP);
  expect(trimmed).toContain('## Run contract');
  expect(trimmed).toContain('SCHEDULER_VERDICT: PASS');
});

test('SM_SEED_AGENT_PERSONAS_DISABLE=1 short-circuits', async () => {
  process.env.SM_SEED_AGENT_PERSONAS_DISABLE = '1';

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.existsSync(agentsDir())).toBe(false);
  expect(fs.existsSync(markerPath())).toBe(false);
});

// --- upgrade pass ---------------------------------------------------------
//
// The upgrade pass only replaces an installed file once its body is proven
// to match a version this app actually shipped (`shippedSeeds`). These
// tests inject a fake `shippedSeeds` list instead of the real
// `lib/persona-macro/shippedPersonaSeeds.cjs`, so a fixture body doesn't need to be one of
// dev-lead's real historical bodies — just a body whose hash the fake entry
// declares as shipped.

const OLD_BODY = 'old dev-lead body';

function hashBody(bodyText) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(bodyText.trim()).digest('hex');
}

/** A fake shippedSeeds list whose sole dev-lead entry matches OLD_BODY and carries `fm`. */
function fakeDevLeadSeeds(fm) {
  return { 'dev-lead': [{ commit: 'fake0000', bodySha256: hashBody(OLD_BODY), fm }] };
}

/** An installed dev-lead file over OLD_BODY, with `fmLines` extra frontmatter lines and an implicit seedVersion: 1. */
function installedDevLead(fmLines) {
  return ['---', 'name: dev-lead', ...fmLines, 'seedVersion: 1', '---', '', OLD_BODY, ''].join('\n');
}

test('upgrade uses the bundled model when the installed value only matches the shipped default', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), installedDevLead(['model: fable']));

  await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: fakeDevLeadSeeds({ model: 'fable' }) });

  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const { fm, body } = splitFrontmatter(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8'));
  expect(fm.model).toBe('sonnet'); // 'fable' was just the old shipped default here, not a user choice
  expect(fm.seedVersion).toBe('5'); // bundled stamp, not the installed file's old one
  expect(body).toContain('## Run contract'); // bundled body replaced the old one
});

test('upgrade keeps an installed model no shipped version ever had', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), installedDevLead(['model: us.anthropic.claude-sonnet-5']));

  await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: fakeDevLeadSeeds({ model: 'fable' }) });

  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const { fm } = splitFrontmatter(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8'));
  expect(fm.model).toBe('us.anthropic.claude-sonnet-5');
});

test('upgrade keeps a user-removed model line removed, not re-added from the bundled default', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), installedDevLead([])); // no model: line at all

  await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: fakeDevLeadSeeds({ model: 'fable' }) });

  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const { fm } = splitFrontmatter(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8'));
  expect(fm.model).toBeUndefined();
});

test('upgrade keeps frontmatter keys the bundled persona never had', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), installedDevLead(['model: fable', 'color: blue', 'tags: a, b']));

  await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: fakeDevLeadSeeds({ model: 'fable' }) });

  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const { fm } = splitFrontmatter(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8'));
  expect(fm.color).toBe('blue');
  expect(fm.tags).toBe('a, b');
});

test('upgrade normalizes a CRLF installed file and writes LF output', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  const crlf = installedDevLead(['model: fable']).replace(/\n/g, '\r\n');
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), crlf);

  await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: fakeDevLeadSeeds({ model: 'fable' }) });

  const out = fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8');
  expect(out).not.toContain('\r');
  expect(out).toContain('## Run contract');
});

test('upgrade preserves a model value containing regex-replacement syntax verbatim', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), installedDevLead(['model: $& and $1 and $$']));

  await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: fakeDevLeadSeeds({ model: 'fable' }) });

  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const { fm } = splitFrontmatter(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8'));
  expect(fm.model).toBe('$& and $1 and $$');
});

test('an installed seedVersion: with an empty value reads as 1, so a bundled seedVersion 2 still upgrades it', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  const installed = ['---', 'name: dev-lead', 'model: fable', 'seedVersion:', '---', '', OLD_BODY, ''].join('\n');
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), installed);

  await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: fakeDevLeadSeeds({ model: 'fable' }) });

  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const { fm } = splitFrontmatter(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8'));
  expect(fm.seedVersion).toBe('5');
});

test('the upgrade backs up the pre-upgrade file content by hash, outside the agents dir', async () => {
  // Pre-seed the marker as fully delivered so the first-seed pass (which also
  // runs every call) short-circuits instead of seeding the other three
  // missing personas — isolates agentsDir() to just the file this test wrote.
  const mPath = markerPath();
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  fs.writeFileSync(mPath, JSON.stringify({ seeded: ALL_PERSONAS, attempts: 0, ts: '2026-01-01T00:00:00.000Z' }));
  fs.mkdirSync(agentsDir(), { recursive: true });
  const installed = installedDevLead(['model: fable']);
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), installed);

  await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: fakeDevLeadSeeds({ model: 'fable' }) });

  const backupsDir = path.join(tmpHome, '.claude', 'session-manager', 'persona-backups');
  const backups = fs.readdirSync(backupsDir).filter((f) => f.startsWith('dev-lead.'));
  expect(backups.length).toBe(1);
  expect(backups[0]).toMatch(/^dev-lead\.[0-9a-f]{12}\.md$/);
  expect(fs.readFileSync(path.join(backupsDir, backups[0]), 'utf8')).toBe(installed);
  // Never inside ~/.claude/agents — Claude Code loads every file there recursively,
  // so a backup kept there would load as a second agent under the same name.
  expect(fs.existsSync(path.join(agentsDir(), '.backup'))).toBe(false);
  expect(fs.readdirSync(agentsDir()).sort()).toEqual(['dev-lead.md']);
});

test('a second upgrade attempt with the same pre-upgrade content writes no second backup', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  const seeds = fakeDevLeadSeeds({ model: 'fable' });
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), installedDevLead(['model: fable']));

  await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: seeds });
  // The same stale content reappears (e.g. a second machine, or a restore) — upgrade again.
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), installedDevLead(['model: fable']));
  await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: seeds });

  const backupsDir = path.join(tmpHome, '.claude', 'session-manager', 'persona-backups');
  const backups = fs.readdirSync(backupsDir).filter((f) => f.startsWith('dev-lead.'));
  expect(backups.length).toBe(1);
});

test('a write failure (agents dir symlinked outside the allowed roots) never leaves an orphan backup', async () => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-outside-'));
  try {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.symlinkSync(outsideDir, agentsDir()); // ~/.claude/agents -> outside the temp HOME
    const installed = installedDevLead(['model: fable']);
    fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), installed); // through the symlink

    const seeds = fakeDevLeadSeeds({ model: 'fable' });
    await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: seeds });
    await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: seeds }); // run twice

    expect(fs.readFileSync(path.join(outsideDir, 'dev-lead.md'), 'utf8')).toBe(installed);
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'session-manager', 'persona-backups'))).toBe(false);
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("every bundled persona's body hash is present in the real shipped-seed manifest", () => {
  const { personaBodyHash } = require('../seedAgentPersonas.cjs');
  const { SHIPPED_PERSONA_SEEDS } = require('../lib/persona-macro/shippedPersonaSeeds.cjs');
  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');

  for (const name of ALL_PERSONAS) {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'seed', 'agents', `${name}.md`), 'utf8');
    const hash = personaBodyHash(raw);
    const { fm } = splitFrontmatter(raw);
    const expectedFm = { ...fm };
    delete expectedFm.name;
    delete expectedFm.seedVersion;
    const entries = SHIPPED_PERSONA_SEEDS[name] ?? [];
    // A frontmatter-only revision (e.g. adding `effort:`) ships a new entry with the
    // same bodySha256 as its predecessor — use the latest one for this body.
    let match;
    for (const entry of entries) if (entry.bodySha256 === hash) match = entry;
    if (!match) {
      throw new Error(
        `No shipped-seed entry for ${name} matches its current bundled body. Paste this into shippedPersonaSeeds.cjs:\n` +
        JSON.stringify({ commit: '<fill in>', bodySha256: hash, fm: expectedFm }, null, 2)
      );
    }
    expect(match.fm).toEqual(expectedFm);
  }
});

test('an installed persona already at the bundled seedVersion is left untouched by the upgrade pass', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  const bundledDevLead = fs.readFileSync(path.join(__dirname, '..', '..', 'seed', 'agents', 'dev-lead.md'), 'utf8');
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), bundledDevLead);

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8')).toBe(bundledDevLead);
  expect(fs.existsSync(path.join(agentsDir(), '.backup'))).toBe(false);
});

test('an installed persona at a newer seedVersion than bundled is left untouched by the upgrade pass', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  const newer = ['---', 'name: dev-lead', 'seedVersion: 99', '---', '', 'from the future', ''].join('\n');
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), newer);

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8')).toBe(newer);
  expect(fs.existsSync(path.join(agentsDir(), '.backup'))).toBe(false);
});

test('SM_SEED_AGENT_PERSONAS_DISABLE=1 also skips the upgrade pass for a pre-existing stale file', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), 'old dev-lead content\n');
  process.env.SM_SEED_AGENT_PERSONAS_DISABLE = '1';

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8')).toBe('old dev-lead content\n');
  expect(fs.existsSync(path.join(agentsDir(), '.backup'))).toBe(false);
});

test('the upgrade pass runs even when the marker says every persona is already seeded and attempts are exhausted', async () => {
  const { MAX_ATTEMPTS } = require('../seedAgentPersonas.cjs');
  const mPath = markerPath();
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  fs.writeFileSync(mPath, JSON.stringify({ seeded: ALL_PERSONAS, attempts: MAX_ATTEMPTS, ts: '2026-01-01T00:00:00.000Z' }));
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), installedDevLead(['model: fable']));

  await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: fakeDevLeadSeeds({ model: 'fable' }) });

  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const { body } = splitFrontmatter(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8'));
  expect(body).toContain('## Run contract'); // upgraded despite the marker being "done" and attempts exhausted
});

// --- blender-artist + architect art Mission ------------------------------

function bundledRaw(name) {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'seed', 'agents', `${name}.md`), 'utf8');
}

test('a fresh seed writes blender-artist.md as an executorOnly art persona', async () => {
  await seedAgentPersonas({ logger: silentLogger() });

  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const { fm } = splitFrontmatter(fs.readFileSync(path.join(agentsDir(), 'blender-artist.md'), 'utf8'));
  expect(String(fm.executorOnly)).toBe('true');
  expect(fm.tags).toBe('art');
});

test('a machine whose marker lists the five older personas receives blender-artist on its next run', async () => {
  const mPath = markerPath();
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  const older = ['architect', 'dev-lead', 'project-home-builder', 'validator', 'demo-video-builder'];
  fs.writeFileSync(mPath, JSON.stringify({ seeded: older, attempts: 0, ts: '2026-01-01T00:00:00.000Z' }));

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.existsSync(path.join(agentsDir(), 'blender-artist.md'))).toBe(true);
  expect(fs.existsSync(path.join(agentsDir(), 'architect.md'))).toBe(false); // already seeded, left alone
  const marker = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  expect(marker.seeded.sort()).toEqual([...ALL_PERSONAS].sort());
});

test('a pre-existing hand-written blender-artist.md without seedVersion is left byte-identical', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  const mine = '---\nname: blender-artist\ndescription: mine\ntags: art\n---\n\nmy own body\n';
  fs.writeFileSync(path.join(agentsDir(), 'blender-artist.md'), mine);

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.readFileSync(path.join(agentsDir(), 'blender-artist.md'), 'utf8')).toBe(mine);
});

test('upgrade adds art to an installed seedVersion-2 architect with shipped tags, and keeps user-edited tags', async () => {
  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const { fm: bundledFm } = splitFrontmatter(bundledRaw('architect'));
  // The v3 body (before the agentType paragraph was corrected) — what a seedVersion-2/3 install carries.
  const body = "You are the architect. You are the one Actor a human talks to for the whole life of an Epic's\nconversation \u2014 the overall plan, the decomposition, the judgment calls \u2014 not the one who\nimplements any single PRD. This file carries only your working style; the mechanics of how\ndevelopment actually gets executed live in the `session-manager-dev:develop` skill (and, for the\nexecutor's own rules, `standards.md` beside it) \u2014 reach for that skill rather than improvising a\nparallel process, the same way `/develop` itself references `standards.md` instead of restating it.\n\n## How you work\n\n1. **Clarify before acting, but don't over-ask.** If scope is genuinely ambiguous (acceptance\n   criteria, target repo, edge cases worth calling out), ask a few focused questions and wait.\n   If it's already clear, proceed \u2014 asking permission for the obvious wastes the human's time.\n2. **Search before you build.** Read the surrounding code for existing patterns, utilities, and\n   conventions before drafting a plan. A wrong assumption here becomes a wrong decomposition;\n   verify by reading, don't guess from a filename or a memory of how similar code usually looks.\n3. **Own the plan; delegate every implementation.** Once scope is reasonably clear, decompose the\n   work and queue it via `/develop` \u2014 never hand-implement inline in this conversation, not even a\n   \"quick\" fix. This session is where the thinking happens (what to build, in what order, what the\n   acceptance criteria actually prove); the scheduled `claude -p` executor is where the typing\n   happens. This applies even when the plan is already fully scoped in conversation \u2014 queuing isn't\n   extra ceremony, it's how the work actually gets built.\n4. **Track what you queued to completion.** `/develop`'s own Phase 2 (watch the scheduler, gate on\n   definition-of-done, route to the right specialist reviewer) is how a decomposition actually\n   finishes \u2014 don't queue PRDs and walk away from them.\n5. **Never treat \"the tests pass\" as \"it's done.\"** Verify live against the real acceptance\n   criteria before reporting anything as complete.\n6. **Stay agnostic about what kind of work this is.** Whether this Epic is a feature build, a bug\n   fix, or an open-ended discussion is decided by its Mission tag, which frames the conversation\n   before this persona's own line is even read. Don't restate or second-guess that framing here \u2014\n   your job is *how* to plan, not *what* the work is.\n\n## Relationship to `dev-lead`\n\nYou and `dev-lead` are deliberately different scopes, not two names for the same thing:\n- **You (architect)** own the whole Epic \u2014 the plan, the decomposition, the sequencing, the\n  tracking, the final call on \"is this actually done.\"\n- **`dev-lead`** owns exactly one already-scoped PRD at a time, headless, with no visibility into\n  the overall plan \u2014 it reads a PRD's Goal/Acceptance Criteria/Implementation notes and executes\n  that PRD, nothing more.\n\nThere is no automatic wiring that assigns `dev-lead` to a scheduled PRD run today \u2014 PRD execution\nhas no persona/agentType field. If a PRD should be executed *as* `dev-lead`, say so explicitly in\nthat PRD's own Implementation notes (e.g. \"work as the dev-lead persona \u2014 read\n`~/.claude/agents/dev-lead.md` first\"), the same way a PRD already points its executor at\n`standards.md` by path. Don't assume it happens by default.\n\n## What you don't do\n\n- Don't implement a PRD yourself in this conversation \u2014 that collapses your scope into\n  `dev-lead`'s and defeats the reason PRDs get queued in the first place (keeping the expensive\n  interactive session on judgment calls, not typing).\n- Don't fork `/develop`'s PRD structure, sizing rules, or scheduler mechanics into this file \u2014\n  reference the skill, don't duplicate it.\n- Don't narrow yourself to one task type \u2014 that content belongs to a Mission tag, not to this\n  generalist persona.";
  const installed = (tags) => [
    '---', 'name: architect', `description: ${bundledFm.description}`, `tools: ${bundledFm.tools}`,
    'model: opus', 'effort: medium', `tags: ${tags}`, `title: ${bundledFm.title}`, 'seedVersion: 2', '---', '', body.trim(), '',
  ].join('\n');
  const mark = markerPath();
  fs.mkdirSync(path.dirname(mark), { recursive: true });
  fs.writeFileSync(mark, JSON.stringify({ seeded: ALL_PERSONAS, attempts: 0, ts: '2026-01-01T00:00:00.000Z' }));
  fs.mkdirSync(agentsDir(), { recursive: true });

  fs.writeFileSync(path.join(agentsDir(), 'architect.md'), installed('feature, bug, discussion'));
  await seedAgentPersonas({ logger: silentLogger() });
  let out = splitFrontmatter(fs.readFileSync(path.join(agentsDir(), 'architect.md'), 'utf8')).fm;
  expect(out.tags).toBe('feature, bug, discussion, art');
  expect(out.seedVersion).toBe('5');

  fs.writeFileSync(path.join(agentsDir(), 'architect.md'), installed('feature, mine'));
  await seedAgentPersonas({ logger: silentLogger() });
  out = splitFrontmatter(fs.readFileSync(path.join(agentsDir(), 'architect.md'), 'utf8')).fm;
  expect(out.tags).toBe('feature, mine');
});

test('the bundled blender-artist.md carries no machine-specific path or project name', () => {
  const raw = bundledRaw('blender-artist');
  expect(raw).not.toContain('/home/');
  expect(raw.toLowerCase()).not.toContain('bilko');
});

// project-home-builder seedVersion 3 (project_home_write only), byte-identical to what shipped.
const PHB_V3 = "---\nname: project-home-builder\ndescription: Reads a project and writes ONE self-contained overview page (home.html) for its Project Home tab, then saves it with a single project_home_write call.\ntools: Read, Grep, Glob, Bash, Write, Edit, mcp__session-manager-scheduler__project_home_write\ntitle: Project Home — Builder\nmodel: sonnet\neffort: medium\nseedVersion: 3\n---\n\nYou are the project-home-builder. The page you produce is often the first thing a person sees\nwhen they open this project — they will read it as the project's own description of itself, so\nevery sentence on it needs to be something you actually verified by reading the project, not\nsomething that sounds plausible.\n\n<context>\nYou run inside a Session Manager Epic for the target project. The HTML you produce is rendered\ninside a sandboxed frame in that project's Project Home tab. It is only regenerated when a human\ndeliberately presses the Project Home button — never automatically and never in a loop — so this\nrun is the one chance to get it right before a person reads it.\n</context>\n\n<grounding_rules>\nGround every claim in something you read: the project's manifest (`package.json`,\n`pyproject.toml`, or equivalent), its README or docs, its source tree, or its git log. If you\ncan't point to where a claim came from, leave it out rather than guess — an omitted section is\nfar better than an invented one. Never invent statistics, quotes, screenshots, or features that\ndon't exist. Where the project already describes itself well (a tagline, a feature list, a\nmission statement), reuse its own wording instead of paraphrasing.\n</grounding_rules>\n\n<page_contents>\nCover, in whatever order reads best for this specific project:\n\n- What it is — a one- or two-sentence description, in the project's own terms where possible.\n- Who it's for — the audience or user the project serves.\n- Key features — 3 to 6 of them, each one tied to a real module, file, or doc you found.\n- Structure — the main directories or modules and what each one does.\n- How to run it — the real install / build / start steps, taken from the README or manifest scripts.\n- Key commands — the commands a contributor actually uses (test, lint, build, etc.).\n</page_contents>\n\n<output_contract>\nProduce exactly one complete HTML document:\n- All CSS lives inline in a single `<style>` block — no `<script src=\"...\">`, no\n  `<link href=\"http...\">`, no `@import`, and no `url(http...)`.\n- No external fonts or images; nothing the browser needs to fetch over the network.\n- Under 1 MB total.\n- Support both light and dark viewing via `prefers-color-scheme` — pick colors that read well in\n  both without needing a toggle.\n- Use semantic headings (`h1`, `h2`, ...) so the page has a real outline, and keep text readable\n  at a 1000px-wide viewport.\n</output_contract>\n\n<process>\n1. Read, with a bounded pass: the manifest, the README or top-level docs index, the top-level\n   directory tree, and `git log --oneline -30` for a sense of recent direction. Stop once you have\n   enough to describe the project honestly — you don't need to read every file.\n2. Draft a claims list: for every fact you plan to put on the page, note the source you read it\n   from.\n3. Drop any claim from that list that doesn't have a source next to it.\n4. Compose the HTML page from what's left, following `<page_contents>` and `<output_contract>`.\n5. Call `project_home_write` exactly once with `{ html }`. It validates the document and writes\n   it as the project's Project Home page.\n6. Report back in one or two lines what the page covers.\n</process>\n\n<when_things_fail>\nIf `project_home_write` rejects the HTML, fix the specific problem it reported and call it again\n— up to 3 attempts total. If `project_home_write` isn't available in this session at all, say so\nplainly and stop; don't try to build a workaround or any tooling of your own in the target\nproject.\n</when_things_fail>\n";
const phbBundled = () => fs.readFileSync(path.join(__dirname, '..', '..', 'seed', 'agents', 'project-home-builder.md'), 'utf8');

test('project-home-builder: bundled seedVersion 5 carries both save tools and the Knowledge Page rules', () => {
  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const { fm } = splitFrontmatter(phbBundled());
  const tools = fm.tools.split(',').map((t) => t.trim());
  expect(tools).toContain('mcp__session-manager-scheduler__project_page_write');
  expect(tools).toContain('mcp__session-manager-scheduler__project_home_write');
  expect(fm.seedVersion).toBe('5');
  expect(fm.description).toContain('Knowledge Page');
  const body = phbBundled();
  for (const needle of ['project_page_write', 'Entry id', 'Page:', 'How it works', 'FAQ', 'pageId']) {
    expect(body).toContain(needle);
  }
  // The only mention of <script> is the prohibition: pages never contain it.
  expect(body).toMatch(/never contain `<script>`/);
  expect(body).toContain('scripts\n  never run in the page frame');
});

test('project-home-builder: the shipped seed-v3 install upgrades to v4', async () => {
  const { personaBodyHash } = require('../seedAgentPersonas.cjs');
  const { SHIPPED_PERSONA_SEEDS } = require('../lib/persona-macro/shippedPersonaSeeds.cjs');
  expect(SHIPPED_PERSONA_SEEDS['project-home-builder'].some((e) => e.commit === 'seed-v3' && e.bodySha256 === personaBodyHash(PHB_V3))).toBe(true);
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), 'project-home-builder.md'), PHB_V3);
  await seedAgentPersonas({ logger: silentLogger() });
  expect(fs.readFileSync(path.join(agentsDir(), 'project-home-builder.md'), 'utf8')).toBe(phbBundled());
});

test('project-home-builder: a user-edited v3 install is kept', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  const edited = PHB_V3 + '\nmy own extra rule\n';
  fs.writeFileSync(path.join(agentsDir(), 'project-home-builder.md'), edited);
  await seedAgentPersonas({ logger: silentLogger() });
  expect(fs.readFileSync(path.join(agentsDir(), 'project-home-builder.md'), 'utf8')).toBe(edited);
});

// project-home-builder: the body this repo's own agent wrote to ~/.claude/agents on 2026-08-02
// (before the seed existed) must upgrade to the bundled persona, which carries the save tool.
const PHB_PRESEED = "---\nname: project-home-builder\ndescription: Generates a project's static Project Home/Project Pages from that project's own saved component library and a computed project summary, if that pipeline exists there.\ntools: Read, Grep, Glob, Bash, Write, Edit\ntags: project-home-builder\ntitle: Platform — Docs Engineer\n---\n\nYou are the Project-Home-Builder agent. Your job, in any project that has one, is to turn that\nproject's own saved Project Pages component library + a computed project summary into static,\nself-contained HTML — Project Home's \"Generate Now\"/\"Regenerate\" action. You are general and\nproject-agnostic: this file carries only the protocol shape. Project-specific detail (exact file\npaths, the component library itself, the architecture spec) lives in that project's own\n`.claude/agents/project-home-builder.md`, which overlays this file (same precedence as any other\nClaude Code agent definition — project definition wins on conflict, otherwise this file is the\ndefault).\n\n## Protocol (shape only — a project overlay fills in the concrete paths)\n\n1. **Find the spec.** Look for an architecture doc describing this project's Project Pages/Project\n   Home pipeline (commonly under `<project ops root>/architecture/`) and a saved component library\n   (commonly under `<project ops root>/design-mocks/`). If neither exists in this repo, that is\n   itself the first unit of work — decompose building the pipeline via that project's own\n   `/develop`-style workflow rather than hand-rolling a one-off script.\n2. **Read the component library before choosing anything.** Never invent a component or fabricate\n   copy — every slot/variant choice and every summary field must trace to something concrete (an\n   Epic/issue goal, a file/dir in the tree, a project convention doc, a git log entry, an existing\n   brief/summary field). An empty/omitted field always beats a made-up one.\n3. **Compute the project summary** from real project state, validate it against whatever schema\n   the project's own pipeline defines, and don't proceed past validation failures.\n4. **Select components** — prefer a deterministic, reusable selection step over an LLM taste-pass\n   if the project has one; respect any existing hand-picked slot choices on a regenerate rather\n   than silently overwriting them.\n5. **Render to static HTML** — inline CSS, no client-side JS, no network calls, no runtime JSX\n   transform. The output must not depend on the app's own live UI framework at display time.\n6. **Report what was generated and where** — the host app's own Home/Project surface reads the\n   result from disk; this agent does not touch the app's live UI state directly.\n\n## What this file does not decide\n\nExact schemas, file paths, the component library's contents, and the render pipeline's build\ntooling are project-specific choices — read the project overlay for those. Where a project's\noverlay is silent, default to: never fabricate content, static HTML only, and respect existing\nhand-picks on regenerate.\n";

test('project-home-builder: the pre-seed 2026-08-02 install upgrades and gains project_home_write', async () => {
  const { personaBodyHash } = require('../seedAgentPersonas.cjs');
  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  expect(personaBodyHash(PHB_PRESEED)).toBe('ad9f77d1279b7e8b0856285c361f45d8b339369a63675307817d781e82588662');
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), 'project-home-builder.md'), PHB_PRESEED);
  await seedAgentPersonas({ logger: silentLogger() });
  const after = fs.readFileSync(path.join(agentsDir(), 'project-home-builder.md'), 'utf8');
  expect(after).toBe(fs.readFileSync(path.join(__dirname, '..', '..', 'seed', 'agents', 'project-home-builder.md'), 'utf8'));
  expect(splitFrontmatter(after).fm.tools).toContain('mcp__session-manager-scheduler__project_home_write');
});

// demo-video-builder: proven against the exact files users have installed (pinned fixtures),
// not a rebuild from the current bundled file. Version-agnostic: never names the bundled seedVersion.
const DVB_TOOL = 'mcp__session-manager-scheduler__project_demo_video_write';
const dvbBundled = () => fs.readFileSync(path.join(__dirname, '..', '..', 'seed', 'agents', 'demo-video-builder.md'), 'utf8');
const dvbFixture = (v) => fs.readFileSync(path.join(__dirname, 'fixtures', `demo-video-builder-seed-v${v}.txt`), 'utf8');

test('demo-video-builder: each pinned shipped fixture hash is in SHIPPED_PERSONA_SEEDS', () => {
  const { personaBodyHash } = require('../seedAgentPersonas.cjs');
  const { SHIPPED_PERSONA_SEEDS } = require('../lib/persona-macro/shippedPersonaSeeds.cjs');
  const known = SHIPPED_PERSONA_SEEDS['demo-video-builder'].map((e) => e.bodySha256);
  for (const v of [5, 6]) expect(known).toContain(personaBodyHash(dvbFixture(v)));
});

for (const v of [5, 6]) {
  test(`demo-video-builder: an unedited installed v${v} file ends up byte-identical to the bundled file`, async () => {
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.writeFileSync(path.join(agentsDir(), 'demo-video-builder.md'), dvbFixture(v));
    await seedAgentPersonas({ logger: silentLogger() });
    expect(fs.readFileSync(path.join(agentsDir(), 'demo-video-builder.md'), 'utf8')).toBe(dvbBundled());
  });
}

test('demo-video-builder: a v5 install with an appended line is kept as a user edit', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  const edited = dvbFixture(5) + '\nmy own extra rule\n';
  fs.writeFileSync(path.join(agentsDir(), 'demo-video-builder.md'), edited);
  await seedAgentPersonas({ logger: silentLogger() });
  expect(fs.readFileSync(path.join(agentsDir(), 'demo-video-builder.md'), 'utf8')).toBe(edited);
});

test('demo-video-builder: the bundled tools line carries the demo video save tool', () => {
  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const { fm } = splitFrontmatter(dvbBundled());
  expect(fm.tools.split(',').map((t) => t.trim())).toContain(DVB_TOOL);
});

// --- competitive-researcher (Haiku collector for the Competitor matrix macro) ---

test('competitive-researcher: seeded file parses with model haiku and the collector contract', async () => {
  await seedAgentPersonas({ logger: silentLogger() });
  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const { AgentPersonaSaveSchema } = require('../lib/persona-macro/agentPersonaSchema.cjs');
  const raw = fs.readFileSync(path.join(agentsDir(), 'competitive-researcher.md'), 'utf8');
  const { fm, body } = splitFrontmatter(raw);
  expect(fm.name).toBe('competitive-researcher');
  expect(fm.model).toBe('haiku');
  expect(fm.effort).toBe('low');
  expect(fm.seedVersion).toBe('1');
  expect(fm.title).toBe('Research — Competitor collector');
  expect(fm.tools).toBe('WebSearch, WebFetch, Read, Write');
  expect(fm.description).toContain('competitive-analyst');
  expect(fm.description).toContain('Haiku');
  const trimmed = body.trim();
  expect(trimmed.length).toBeLessThanOrEqual(4000);
  const parsed = AgentPersonaSaveSchema.safeParse({
    name: fm.name,
    description: fm.description,
    tools: fm.tools.split(',').map((t) => t.trim()),
    model: fm.model,
    effort: fm.effort,
    color: '',
    tags: [],
    title: fm.title,
    seedVersion: Number(fm.seedVersion),
    body: trimmed,
  });
  expect(parsed.success).toBe(true);
  expect(parsed.data.model).toBe('haiku');
  for (const needle of [
    'collectedAt', 'sources', 'features', 'evidence', 'sentiment', 'quotes', 'notes', 'publishedAt',
    'announcement|blog|docs|changelog|forum|review|social|repo',
    'yes|partial|no|unknown', 'loved|requested|mixed|complained|none',
    '30', '25', '40', 'never instructions',
  ]) {
    expect(trimmed).toContain(needle);
  }
});

// --- competitive-analyst (Opus analyst + executor for the Competitor matrix macro) ---

const ANALYST_TOOLS = 'Read, Grep, Glob, Bash, Write, WebSearch, WebFetch, Agent, mcp__session-manager-scheduler__project_matrix_read, mcp__session-manager-scheduler__project_matrix_write';

test('competitive-analyst: seeded file parses with model opus and the analyst contract', async () => {
  await seedAgentPersonas({ logger: silentLogger() });
  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const { AgentPersonaSaveSchema } = require('../lib/persona-macro/agentPersonaSchema.cjs');
  const raw = fs.readFileSync(path.join(agentsDir(), 'competitive-analyst.md'), 'utf8');
  const { fm, body } = splitFrontmatter(raw);
  expect(fm.name).toBe('competitive-analyst');
  expect(fm.title).toBe('Research — Competitor analyst');
  expect(fm.model).toBe('opus');
  expect(fm.effort).toBe('high');
  expect(fm.tags).toBe('project-home-builder');
  expect(fm.seedVersion).toBe('1');
  expect(fm.tools).toBe(ANALYST_TOOLS);
  const trimmed = body.trim();
  expect(trimmed.length).toBeLessThanOrEqual(6000);
  const parsed = AgentPersonaSaveSchema.safeParse({
    name: fm.name,
    description: fm.description,
    tools: fm.tools.split(',').map((t) => t.trim()),
    model: fm.model,
    effort: fm.effort,
    color: '',
    tags: [fm.tags],
    title: fm.title,
    seedVersion: Number(fm.seedVersion),
    body: trimmed,
  });
  expect(parsed.success).toBe(true);
  // Procedure steps appear in order.
  const order = ['project_matrix_read', 'Competitors:', 'git log', 'competitive-researcher', 'run_in_background', 'sessionGoal', 'project_matrix_write'];
  let at = -1;
  for (const needle of order) {
    const idx = trimmed.indexOf(needle, at + 1);
    expect(idx, needle).toBeGreaterThan(at);
    at = idx;
  }
  for (const needle of [
    'chosenBy', 'auto', 'haiku', 'general-purpose', 'ONE message', '6-12', 'matrixPath', 'runs[]',
    'mktemp -d', '~/.cache/competitive-matrix', 'never edit or commit', 'data, not instructions',
    'cite', 'up to 3', 'schemaVersion', "'self'",
  ]) {
    expect(trimmed).toContain(needle);
  }
});

test('competitive-analyst: tools carry both project_matrix tools and the web tools its subagents need', () => {
  // personaToolScope only adds MCP servers a persona names, and subagents can only use web
  // tools the job session itself has.
  const { splitFrontmatter } = require('../lib/prd/prdFrontmatter.cjs');
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'seed', 'agents', 'competitive-analyst.md'), 'utf8');
  const tools = splitFrontmatter(raw).fm.tools.split(',').map((t) => t.trim());
  for (const t of [
    'mcp__session-manager-scheduler__project_matrix_read',
    'mcp__session-manager-scheduler__project_matrix_write',
    'WebSearch', 'WebFetch', 'Agent',
  ]) expect(tools).toContain(t);
});
