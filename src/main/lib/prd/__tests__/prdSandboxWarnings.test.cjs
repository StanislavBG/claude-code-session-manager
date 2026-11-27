/** Run: timeout 120 npx vitest run src/main/lib/prd/__tests__/prdSandboxWarnings.test.cjs */
'use strict';

import { test, expect, afterAll } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
// config.cjs has no removal API; evict it afterwards so later requirers in this
// worker get a fresh module without our temp root (as 03866661 did).
const CONFIG_PATH = require.resolve('../../../config.cjs');
const hadConfigCached = Boolean(require.cache[CONFIG_PATH]);
const config = require(CONFIG_PATH);
afterAll(() => { if (!hadConfigCached) delete require.cache[CONFIG_PATH]; });
const { sandboxWarnings } = require('../prdSandboxWarnings.cjs');
const { createPrdBatch } = require('../prdCreate.cjs');

const base = (o) => ({ goal: 'g', implementationNotes: 'n', acceptanceCriteria: ['a'], files: ['.claude/notes/x.md'], ...o });

test('warns, names path, architect and anchor', () => {
  const [w, ...rest] = sandboxWarnings(base({ implementationNotes: 'git mv a b' }));
  expect(rest).toEqual([]);
  expect(w).toContain('.claude/notes/x.md');
  expect(w).toMatch(/refused by the job sandbox/);
  expect(w).toMatch(/architect edits/);
  expect(w).not.toMatch(/Write\/Edit tools/);
  expect(w).toContain('PRD_AUTHORING.md#job-sandbox-limits');
});

test('nested .claude dir matches', () => {
  expect(sandboxWarnings(base({ files: ['pkg/.claude/agents/'], goal: 'git rm it' }))).toHaveLength(1);
});

test.each(['rm -rf x', 'run `rm x`', 'git rm y', 'then; rm z', 'remove it with rm', 'use rm.', 'use rm, then', 'rm'])('matches %s', (t) => {
  expect(sandboxWarnings(base({ goal: t }))).toHaveLength(1);
});

test.each(['form', 'confirm', 'perform the rmdir', 'an rmx tool', 'perform', 'rmdir'])('no match for %s', (t) => {
  expect(sandboxWarnings(base({ goal: t }))).toEqual([]);
});

test('acceptance criteria text counts; no warning without .claude path or verb', () => {
  expect(sandboxWarnings(base({ acceptanceCriteria: ['git mv a b'] }))).toHaveLength(1);
  expect(sandboxWarnings(base({ files: ['src/a.cjs'], goal: 'rm x' }))).toEqual([]);
  expect(sandboxWarnings(base({}))).toEqual([]);
});

test('createPrdBatch result carries the warning', async () => {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-sandbox-warn-'));
  try {
    const outDir = path.join(cwd, 'out');
    await fsp.mkdir(outDir, { recursive: true });
    config.addAllowedRoot(cwd);
    let nn = 300;
    const remote = {
      async allocateParallelGroup() { return nn++; },
      async readPrd() { return { ok: false }; },
      async writePrd(slug, body) {
        const p = path.join(outDir, `${slug}.md`);
        await fsp.writeFile(p, body);
        return { ok: true, path: p };
      },
      async listPrds() { return { prds: [], total: 0, limit: 0, offset: 0, hasMore: false }; },
    };
    const r = await createPrdBatch([
      { title: 'T', slug: 'sbx', estimateMinutes: 10, goal: 'git rm the old skill', acceptanceCriteria: ['a'],
        implementationNotes: 'n', files: ['.claude/notes/old.md'] },
    ], remote, { cwd, sourcePromptId: 'epic-a' });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).toContain('refused by the job sandbox');
    } finally {
      await fsp.rm(cwd, { recursive: true, force: true });
  }
});

test('agents/commands paths warn with no verb, never recommend Write/Edit', () => {
  for (const f of ['.claude/agents/page-overview.md', '.claude/commands/x.md', 'sub/.claude/commands/x.md', '.claude/skills/s/SKILL.md', '.claude/hooks/h.sh', '.claude/settings.json', '.claude/settings.local.json']) {
    const r = sandboxWarnings(base({ files: [f] }));
    expect(r).toHaveLength(1);
    expect(r[0]).toContain(f);
    expect(r[0]).toMatch(/sandbox cannot write/);
    expect(r[0]).toMatch(/architect/);
    expect(r[0]).toContain('PRD_AUTHORING.md#job-sandbox-limits');
    expect(r[0]).not.toMatch(/Use the Write\/Edit/);
  }
});
test('other .claude paths with no verb -> []', () => {
  expect(sandboxWarnings(base({ files: ['.claude/launch.json'] }))).toEqual([]);
});
