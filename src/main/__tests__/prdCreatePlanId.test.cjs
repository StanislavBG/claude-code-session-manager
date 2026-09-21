/**
 * prdCreatePlanId.test.cjs — createPrd() stamps a durable `planId` (wave identity):
 * first-ever PRD mints, append inherits the terminal's, new-head mints, explicit
 * multi-dep inherits the lowest-numbered dependency's (diverged ids logged once).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdCreatePlanId.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const prdParser = require('../scheduler/prdParser.cjs');
const { parsePrdFile } = require('../lib/prdFrontmatter.cjs');
const { createPrd } = require('../lib/prdCreate.cjs');
const { resolveInheritedPlanId, isValidPlanId } = require('../lib/prdDisposition.cjs');

async function mkTmpPrdsDir() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-planid-create-prd-'));
  config.addAllowedRoot(root);
  const prdsDir = path.join(root, '.claude', 'prds');
  await fsp.mkdir(prdsDir, { recursive: true });
  return prdsDir;
}

function makeFakeRemote(prdsDir, statusBySlug = {}) {
  return {
    async allocateParallelGroup() { return prdParser.allocateParallelGroup(prdsDir); },
    async readPrd(slug) {
      try { return { ok: true, text: await fsp.readFile(path.join(prdsDir, `${slug}.md`), 'utf8') }; }
      catch (e) { return { ok: false, error: e?.message }; }
    },
    async writePrd(slug, body) {
      await config.writeTextAtomic(path.join(prdsDir, `${slug}.md`), body, { writer: 'scheduler' });
      return { ok: true };
    },
    async listPrds() {
      const prds = [];
      for (const f of await fsp.readdir(prdsDir)) {
        if (!f.endsWith('.md')) continue;
        const slug = f.slice(0, -3);
        const { frontmatter } = parsePrdFile(await fsp.readFile(path.join(prdsDir, f), 'utf8'));
        prds.push({
          slug,
          sourcePromptId: frontmatter.sourcePromptId ?? null,
          dependsOn: frontmatter.dependsOn ?? null,
          planId: frontmatter.planId ?? null,
          status: statusBySlug[slug] ?? null,
        });
      }
      return { prds, total: prds.length, limit: prds.length, offset: 0, hasMore: false };
    },
  };
}

async function seedPrd(prdsDir, slug, { planId, dependsOn } = {}) {
  const lines = ['---', 'title: seed', 'sourcePromptId: epic-1'];
  if (dependsOn) lines.push(`dependsOn: [${dependsOn.join(', ')}]`);
  if (planId) lines.push(`planId: ${planId}`);
  lines.push('---', '# Goal', '', 'seed', '');
  await fsp.writeFile(path.join(prdsDir, `${slug}.md`), lines.join('\n'));
}

const body = (o = {}) => ({
  title: 'Next wave', cwd: os.homedir(), estimateMinutes: 10, goal: 'g',
  acceptanceCriteria: ['a'], implementationNotes: 'n', ...o,
});
const planIdOf = async (dir, result) =>
  parsePrdFile(await fsp.readFile(path.join(dir, result.filename), 'utf8')).frontmatter.planId;

const originalJobSlug = process.env.SM_SCHEDULER_JOB_SLUG;
beforeEach(() => { delete process.env.SM_SCHEDULER_JOB_SLUG; });
afterEach(() => {
  vi.restoreAllMocks();
  if (originalJobSlug === undefined) delete process.env.SM_SCHEDULER_JOB_SLUG;
  else process.env.SM_SCHEDULER_JOB_SLUG = originalJobSlug;
});

test('first-ever PRD in an Epic mints a valid planId', async () => {
  const dir = await mkTmpPrdsDir();
  const r = await createPrd(body({ sourcePromptId: 'epic-1' }), makeFakeRemote(dir));
  expect(r.ok).toBe(true);
  expect(isValidPlanId(await planIdOf(dir, r))).toBe(true);
});

test('a caller-supplied planId is ignored (API-owned)', async () => {
  const dir = await mkTmpPrdsDir();
  const r = await createPrd(body({ planId: 'evil-id' }), makeFakeRemote(dir));
  expect(await planIdOf(dir, r)).not.toBe('evil-id');
});

test('append inherits the chain terminal\'s planId', async () => {
  const dir = await mkTmpPrdsDir();
  await seedPrd(dir, '1-tail', { planId: 'pl-abc' });
  const r = await createPrd(body({ sourcePromptId: 'epic-1', disposition: 'append' }), makeFakeRemote(dir, { '1-tail': 'pending' }));
  expect(r.ok).toBe(true);
  expect(await planIdOf(dir, r)).toBe('pl-abc');
});

test('new-head mints a fresh planId, distinct from the existing plan', async () => {
  const dir = await mkTmpPrdsDir();
  await seedPrd(dir, '1-tail', { planId: 'pl-abc' });
  const r = await createPrd(body({ sourcePromptId: 'epic-1', disposition: 'new-head' }), makeFakeRemote(dir, { '1-tail': 'pending' }));
  const id = await planIdOf(dir, r);
  expect(isValidPlanId(id)).toBe(true);
  expect(id).not.toBe('pl-abc');
});

test('explicit multi-dep across two plans inherits the lowest-numbered dependency\'s and warns once', async () => {
  const dir = await mkTmpPrdsDir();
  await seedPrd(dir, '9-late', { planId: 'pl-late' });
  await seedPrd(dir, '2-early', { planId: 'pl-early' });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const r = await createPrd(body({ dependsOn: ['9-late', '2-early'] }), makeFakeRemote(dir));
  expect(r.ok).toBe(true);
  expect(await planIdOf(dir, r)).toBe('pl-early');
  expect(warn.mock.calls.filter((c) => String(c[0]).includes('spans plans')).length).toBe(1);
});

test('deps that predate the stamp fall back to a freshly minted planId', async () => {
  const dir = await mkTmpPrdsDir();
  await seedPrd(dir, '1-legacy');
  const r = await createPrd(body({ dependsOn: ['1-legacy'] }), makeFakeRemote(dir));
  expect(isValidPlanId(await planIdOf(dir, r))).toBe(true);
});

test('resolveInheritedPlanId ignores garbage planIds', () => {
  expect(resolveInheritedPlanId(['1-a'], [{ slug: '1-a', planId: 'bad id,[x]' }]).planId).toBeNull();
});
