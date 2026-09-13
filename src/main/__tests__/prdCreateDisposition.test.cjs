/**
 * prdCreateDisposition.test.cjs — scheduler wave-disposition PRD:
 * createPrd()'s authoring-time disposition gate. A PRD landing as a wave
 * ROOT (no dependsOn of its own) in an Epic that already has incomplete
 * PRDs must record an explicit 'append'/'new-head' choice — required for an
 * interactive caller, defaulted (and logged) for a non-interactive one.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdCreateDisposition.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const prdParser = require('../scheduler/prdParser.cjs');
const { parsePrdFile } = require('../lib/prdFrontmatter.cjs');
const { createPrd } = require('../lib/prdCreate.cjs');

async function mkTmpPrdsDir() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-disposition-create-prd-'));
  config.addAllowedRoot(root);
  const prdsDir = path.join(root, '.claude', 'prds');
  await fsp.mkdir(prdsDir, { recursive: true });
  return prdsDir;
}

/** Minimal fake `remote` — same shape as prdCreate.test.cjs's
 *  makeFakeRemoteWithPrdsDir, but listPrds also reports sourcePromptId/
 *  dependsOn (read back from each seeded file's real frontmatter) and
 *  status (from the test-supplied statusBySlug map) — the fields
 *  createPrd()'s disposition gate actually reads. */
function makeFakeRemote(prdsDir, statusBySlug = {}) {
  return {
    async allocateParallelGroup() {
      return prdParser.allocateParallelGroup(prdsDir);
    },
    async readPrd(slug) {
      try {
        const text = await fsp.readFile(path.join(prdsDir, `${slug}.md`), 'utf8');
        return { ok: true, text };
      } catch (e) {
        return { ok: false, error: e?.message };
      }
    },
    async writePrd(slug, body) {
      try {
        const filePath = path.join(prdsDir, `${slug}.md`);
        await config.writeTextAtomic(filePath, body, { writer: 'scheduler' });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message };
      }
    },
    async listPrds() {
      const entries = await fsp.readdir(prdsDir);
      const prds = [];
      for (const f of entries) {
        if (!f.endsWith('.md')) continue;
        const slug = f.slice(0, -3);
        const raw = await fsp.readFile(path.join(prdsDir, f), 'utf8');
        const { frontmatter } = parsePrdFile(raw);
        prds.push({
          slug,
          sourcePromptId: frontmatter.sourcePromptId ?? null,
          dependsOn: frontmatter.dependsOn ?? null,
          status: statusBySlug[slug] ?? null,
        });
      }
      return { prds, total: prds.length, limit: prds.length, offset: 0, hasMore: false };
    },
  };
}

/** Seeds a fixture PRD file directly (bypassing createPrd) at an explicit,
 *  already-NN-prefixed slug, so tests can assert dependsOn against a known
 *  name instead of a freshly-allocated one. */
async function seedPrd(prdsDir, slug, { sourcePromptId, dependsOn } = {}) {
  const lines = ['---', 'title: seed', `sourcePromptId: ${sourcePromptId}`];
  if (dependsOn && dependsOn.length) lines.push(`dependsOn: [${dependsOn.join(', ')}]`);
  lines.push('---', '# Goal', '', 'seed body', '');
  await fsp.writeFile(path.join(prdsDir, `${slug}.md`), lines.join('\n'));
}

function validBody(overrides = {}) {
  return {
    title: 'Wave 2 root',
    cwd: os.homedir(),
    estimateMinutes: 10,
    goal: 'Do the follow-on work.',
    acceptanceCriteria: ['a'],
    implementationNotes: 'n',
    ...overrides,
  };
}

// This suite's own process may itself be running as a scheduled job (this
// file's disposition gate keys directly off SM_SCHEDULER_JOB_SLUG — see
// createPrd()) — never assume it's unset going in; each test controls it
// explicitly.
const originalJobSlug = process.env.SM_SCHEDULER_JOB_SLUG;
beforeEach(() => {
  delete process.env.SM_SCHEDULER_JOB_SLUG;
});
afterEach(() => {
  if (originalJobSlug === undefined) delete process.env.SM_SCHEDULER_JOB_SLUG;
  else process.env.SM_SCHEDULER_JOB_SLUG = originalJobSlug;
});

test('refuses to write, without a disposition, a new root joining an Epic that already has an incomplete PRD', async () => {
  const prdsDir = await mkTmpPrdsDir();
  await seedPrd(prdsDir, '1-wave1-tail', { sourcePromptId: 'epic-1' });
  const remote = makeFakeRemote(prdsDir, { '1-wave1-tail': 'pending' });

  const result = await createPrd(validBody({ sourcePromptId: 'epic-1' }), remote);

  expect(result.ok).toBe(false);
  expect(result.status).toBe(400);
  expect(result.error).toMatch(/disposition/i);
});

test('disposition: append attaches the new root behind the Epic\'s current terminal PRD', async () => {
  const prdsDir = await mkTmpPrdsDir();
  await seedPrd(prdsDir, '1-wave1-tail', { sourcePromptId: 'epic-1' });
  const remote = makeFakeRemote(prdsDir, { '1-wave1-tail': 'pending' });

  const result = await createPrd(validBody({ sourcePromptId: 'epic-1', disposition: 'append' }), remote);

  expect(result.ok).toBe(true);
  const written = await fsp.readFile(path.join(prdsDir, result.filename), 'utf8');
  expect(written).toMatch(/^dependsOn: \[1-wave1-tail\]$/m);
  expect(written).toMatch(/^disposition: append$/m);
});

test('disposition: new-head leaves the new root independent (no dependsOn)', async () => {
  const prdsDir = await mkTmpPrdsDir();
  await seedPrd(prdsDir, '1-wave1-tail', { sourcePromptId: 'epic-1' });
  const remote = makeFakeRemote(prdsDir, { '1-wave1-tail': 'pending' });

  const result = await createPrd(validBody({ sourcePromptId: 'epic-1', disposition: 'new-head' }), remote);

  expect(result.ok).toBe(true);
  const written = await fsp.readFile(path.join(prdsDir, result.filename), 'utf8');
  expect(written).not.toContain('dependsOn');
  expect(written).toMatch(/^disposition: new-head$/m);
});

test('a non-interactive caller (SM_SCHEDULER_JOB_SLUG set) with no disposition defaults to append, logged as a default', async () => {
  const prdsDir = await mkTmpPrdsDir();
  await seedPrd(prdsDir, '1-wave1-tail', { sourcePromptId: 'epic-1' });
  const remote = makeFakeRemote(prdsDir, { '1-wave1-tail': 'pending' });
  process.env.SM_SCHEDULER_JOB_SLUG = 'some-running-job';

  const result = await createPrd(validBody({ sourcePromptId: 'epic-1' }), remote);

  expect(result.ok).toBe(true);
  const written = await fsp.readFile(path.join(prdsDir, result.filename), 'utf8');
  expect(written).toMatch(/^dependsOn: \[1-wave1-tail\]$/m);
  expect(written).toMatch(/^disposition: append$/m);
});

test('no disposition required for the first PRD in a brand-new Epic', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemote(prdsDir);

  const result = await createPrd(validBody({ sourcePromptId: 'epic-empty' }), remote);

  expect(result.ok).toBe(true);
  const written = await fsp.readFile(path.join(prdsDir, result.filename), 'utf8');
  expect(written).not.toContain('disposition');
});

test('no disposition required when every existing PRD in the Epic is already completed', async () => {
  const prdsDir = await mkTmpPrdsDir();
  await seedPrd(prdsDir, '1-wave1-tail', { sourcePromptId: 'epic-done' });
  const remote = makeFakeRemote(prdsDir, { '1-wave1-tail': 'completed' });

  const result = await createPrd(validBody({ sourcePromptId: 'epic-done' }), remote);

  expect(result.ok).toBe(true);
  const written = await fsp.readFile(path.join(prdsDir, result.filename), 'utf8');
  expect(written).not.toContain('disposition');
});

test('an explicit dependsOn bypasses the disposition gate entirely', async () => {
  const prdsDir = await mkTmpPrdsDir();
  await seedPrd(prdsDir, '1-wave1-tail', { sourcePromptId: 'epic-1' });
  const remote = makeFakeRemote(prdsDir, { '1-wave1-tail': 'pending' });

  const result = await createPrd(
    validBody({ sourcePromptId: 'epic-1', dependsOn: ['1-wave1-tail'] }),
    remote,
  );

  expect(result.ok).toBe(true);
  const written = await fsp.readFile(path.join(prdsDir, result.filename), 'utf8');
  expect(written).toMatch(/^dependsOn: \[1-wave1-tail\]$/m);
  expect(written).not.toContain('disposition');
});
