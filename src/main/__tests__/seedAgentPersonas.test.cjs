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

const ALL_PERSONAS = ['architect', 'dev-lead', 'project-home-builder', 'validator'];

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

test('the bundled project-home-builder persona contains no session-manager-repo paths', () => {
  const content = fs.readFileSync(
    path.join(__dirname, '..', '..', 'seed', 'agents', 'project-home-builder.md'),
    'utf8'
  );
  const forbidden = [
    'session-manager-operations/architecture/',
    '.claude/agents/',
    'session-manager-operations/design-mocks/',
    'scripts/',
    'npm run build:project-pages',
  ];
  for (const substr of forbidden) {
    expect(content).not.toContain(substr);
  }
});

test('seeded dev-lead persona pins an executor-tier model', () => {
  const { splitFrontmatter } = require('../lib/prdFrontmatter.cjs');
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'seed', 'agents', 'dev-lead.md'), 'utf8');
  const { fm } = splitFrontmatter(raw);
  expect(fm.model).toBe('sonnet');
});

test('seeded dev-lead body fits AGENT_BODY_CHAR_CAP and carries the run contract', () => {
  const { splitFrontmatter } = require('../lib/prdFrontmatter.cjs');
  const { AGENT_BODY_CHAR_CAP } = require('../lib/agentModelResolve.cjs');
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
// `lib/shippedPersonaSeeds.cjs`, so a fixture body doesn't need to be one of
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

  const { splitFrontmatter } = require('../lib/prdFrontmatter.cjs');
  const { fm, body } = splitFrontmatter(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8'));
  expect(fm.model).toBe('sonnet'); // 'fable' was just the old shipped default here, not a user choice
  expect(fm.seedVersion).toBe('2'); // bundled stamp, not the installed file's old one
  expect(body).toContain('## Run contract'); // bundled body replaced the old one
});

test('upgrade keeps an installed model no shipped version ever had', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), installedDevLead(['model: us.anthropic.claude-sonnet-5']));

  await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: fakeDevLeadSeeds({ model: 'fable' }) });

  const { splitFrontmatter } = require('../lib/prdFrontmatter.cjs');
  const { fm } = splitFrontmatter(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8'));
  expect(fm.model).toBe('us.anthropic.claude-sonnet-5');
});

test('upgrade keeps a user-removed model line removed, not re-added from the bundled default', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), installedDevLead([])); // no model: line at all

  await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: fakeDevLeadSeeds({ model: 'fable' }) });

  const { splitFrontmatter } = require('../lib/prdFrontmatter.cjs');
  const { fm } = splitFrontmatter(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8'));
  expect(fm.model).toBeUndefined();
});

test('upgrade keeps frontmatter keys the bundled persona never had', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), installedDevLead(['model: fable', 'color: blue', 'tags: a, b']));

  await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: fakeDevLeadSeeds({ model: 'fable' }) });

  const { splitFrontmatter } = require('../lib/prdFrontmatter.cjs');
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

  const { splitFrontmatter } = require('../lib/prdFrontmatter.cjs');
  const { fm } = splitFrontmatter(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8'));
  expect(fm.model).toBe('$& and $1 and $$');
});

test('an installed seedVersion: with an empty value reads as 1, so a bundled seedVersion 2 still upgrades it', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  const installed = ['---', 'name: dev-lead', 'model: fable', 'seedVersion:', '---', '', OLD_BODY, ''].join('\n');
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), installed);

  await seedAgentPersonas({ logger: silentLogger(), shippedSeeds: fakeDevLeadSeeds({ model: 'fable' }) });

  const { splitFrontmatter } = require('../lib/prdFrontmatter.cjs');
  const { fm } = splitFrontmatter(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8'));
  expect(fm.seedVersion).toBe('2');
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
  const { SHIPPED_PERSONA_SEEDS } = require('../lib/shippedPersonaSeeds.cjs');
  const { splitFrontmatter } = require('../lib/prdFrontmatter.cjs');

  for (const name of ALL_PERSONAS) {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'seed', 'agents', `${name}.md`), 'utf8');
    const hash = personaBodyHash(raw);
    const { fm } = splitFrontmatter(raw);
    const expectedFm = { ...fm };
    delete expectedFm.name;
    delete expectedFm.seedVersion;
    const entries = SHIPPED_PERSONA_SEEDS[name] ?? [];
    const match = entries.find((e) => e.bodySha256 === hash);
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

  const { splitFrontmatter } = require('../lib/prdFrontmatter.cjs');
  const { body } = splitFrontmatter(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8'));
  expect(body).toContain('## Run contract'); // upgraded despite the marker being "done" and attempts exhausted
});
