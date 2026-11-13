/**
 * prdFrontmatterEffort.test.cjs — `effort` (an in-process-only per-PRD effort
 * override, e.g. a macro press run at medium) is a recognized frontmatter key
 * restricted to the closed PRD_EFFORT_LEVELS set.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdFrontmatterEffort.test.cjs
 */

'use strict';

import { test, expect, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { parsePrdFile, serializePrdFile, RECOGNIZED_KEYS, PRD_EFFORT_LEVELS } = require('../lib/prd/prdFrontmatter.cjs');
const { buildPrdBody, createPrd } = require('../lib/prd/prdCreate.cjs');
const prdParser = require('../scheduler/prdParser.cjs');
const config = require('../config.cjs');

test('effort is a recognized key', () => {
  expect(RECOGNIZED_KEYS.has('effort')).toBe(true);
});

test('PRD_EFFORT_LEVELS mirrors the model catalog floor', () => {
  expect(PRD_EFFORT_LEVELS).toEqual(require('../lib/claude/modelCatalog.cjs').CATALOG_FLOOR.effortLevels);
  expect(Object.isFrozen(PRD_EFFORT_LEVELS)).toBe(true);
});

test('effort parses and round-trips, emitted right after macroId', () => {
  const text = '---\ntitle: T\nmacroId: demo-video\neffort: medium\n---\nbody\n';
  const { frontmatter, body } = parsePrdFile(text);
  expect(frontmatter.effort).toBe('medium');
  expect(frontmatter.extras?.effort).toBeUndefined();
  const out = serializePrdFile(frontmatter, body);
  expect(out).toMatch(/macroId: demo-video\neffort: medium\n/);
  expect(parsePrdFile(out).frontmatter.effort).toBe('medium');
  // Fresh emit (no cached raw line) also lands right after macroId.
  const fresh = serializePrdFile({ title: 'T', macroId: 'm1', effort: 'low' }, 'b\n');
  expect(fresh).toMatch(/macroId: m1\neffort: low\n/);
});

test('quoted effort is unquoted and trimmed', () => {
  const { frontmatter } = parsePrdFile('---\ntitle: T\neffort:   "high"  \n---\nb\n');
  expect(frontmatter.effort).toBe('high');
});

test('invalid effort values are dropped', () => {
  for (const bad of ['ultra', 'MAX', '', 'max x']) {
    const { frontmatter } = parsePrdFile(`---\ntitle: T\neffort: ${bad}\n---\nbody\n`);
    expect(frontmatter.effort).toBeUndefined();
  }
});

const BASE = { title: 't', cwd: '~/x', goal: 'g', acceptanceCriteria: ['a'], implementationNotes: 'n' };

test('buildPrdBody emits effort right after macroId only for a valid level', () => {
  expect(buildPrdBody({ ...BASE, macroId: 'mac-1', effort: 'medium' })).toMatch(/^macroId: mac-1\neffort: medium$/m);
  expect(buildPrdBody({ ...BASE, effort: 'xhigh' })).toMatch(/^effort: xhigh$/m);
  for (const bad of [undefined, null, 'turbo', 'MAX', 42]) {
    expect(buildPrdBody({ ...BASE, effort: bad })).not.toMatch(/^effort:/m);
  }
});

async function mkTmpPrdsDir() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prd-effort-'));
  config.addAllowedRoot(root);
  const prdsDir = path.join(root, '.claude', 'prds');
  await fsp.mkdir(prdsDir, { recursive: true });
  return prdsDir;
}

function makeFakeRemote(prdsDir) {
  return {
    async allocateParallelGroup() { return prdParser.allocateParallelGroup(prdsDir); },
    async readPrd() { return { ok: false, error: 'n/a' }; },
    async writePrd(slug, body) {
      await config.writeTextAtomic(path.join(prdsDir, `${slug}.md`), body, { writer: 'scheduler' });
      return { ok: true };
    },
    async listPrds() { return { prds: [], total: 0, limit: 0, offset: 0, hasMore: false }; },
  };
}

function validCreateBody(overrides = {}) {
  return {
    title: 'Add widget frobnication',
    cwd: os.homedir(),
    estimateMinutes: 15,
    goal: 'Add frobnication to the widget subsystem.',
    acceptanceCriteria: ['widget frobnicates on click', 'timeout 300 npm run typecheck passes'],
    implementationNotes: 'See src/widget.cjs:10.',
    outOfScope: ['not touching gadgets'],
    ...overrides,
  };
}

test('createPrd refuses effort "turbo" with 400 naming effort, before NN allocation', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemote(prdsDir);
  const allocSpy = vi.fn(remote.allocateParallelGroup);
  remote.allocateParallelGroup = allocSpy;
  const result = await createPrd(validCreateBody({ effort: 'turbo' }), remote);
  expect(result.ok).toBe(false);
  expect(result.applied).toBe(false);
  expect(result.status).toBe(400);
  expect(result.error).toMatch(/effort/);
  expect(allocSpy).not.toHaveBeenCalled();
  expect(fs.readdirSync(prdsDir)).toEqual([]);
});

test('parsePrdRaw exposes effort from a PRD file, null when absent or invalid', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prd-effort-parse-'));
  const good = path.join(dir, '1-good.md');
  const none = path.join(dir, '2-none.md');
  const bad = path.join(dir, '3-bad.md');
  await fsp.writeFile(good, '---\ntitle: G\neffort: medium\n---\n# Goal\n');
  await fsp.writeFile(none, '---\ntitle: N\n---\n# Goal\n');
  await fsp.writeFile(bad, '---\ntitle: B\neffort: ultra\n---\n# Goal\n');
  expect((await prdParser.parsePrdRaw(good)).effort).toBe('medium');
  expect((await prdParser.parsePrdRaw(none)).effort).toBeNull();
  expect((await prdParser.parsePrdRaw(bad)).effort).toBeNull();
});
