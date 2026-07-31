// PRD 832 — unique per-project PRD numbers + dependsOn eligibility.
// User decision 2026-07-31: duplicate NN must be impossible; ordering is
// expressed via dependsOn frontmatter, never via shared numbers.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const prdParser = require('../scheduler/prdParser.cjs');
const { pickForProject } = require('../lib/schedulerBatch.cjs');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-832-'));
}

const job = (slug, status, group, extra = {}) => ({
  slug, status, parallelGroup: group, cwd: '/proj', ...extra,
});

describe('allocateParallelGroup extraFloor (PRD 832)', () => {
  it('never allocates at or below the cross-dir max', async () => {
    const dir = tmpdir();
    // Bookkeeping dir itself is empty; another dir in the project already
    // used numbers up to 830.
    const nn = await prdParser.allocateParallelGroup(dir, { extraFloor: 830 });
    expect(nn).toBe(831);
    // And the high-water mark persists the raised floor for later calls.
    const nn2 = await prdParser.allocateParallelGroup(dir);
    expect(nn2).toBe(832);
  });

  it('local scan still wins when higher than extraFloor', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, '900-existing.md'), '---\ntitle: x\n---\n# Goal\n');
    const nn = await prdParser.allocateParallelGroup(dir, { extraFloor: 10 });
    expect(nn).toBe(901);
  });
});

describe('parsePrdRaw dependsOn (PRD 832)', () => {
  it('parses bracket and comma forms, rejects junk', async () => {
    const dir = tmpdir();
    const fp = path.join(dir, '840-x.md');
    fs.writeFileSync(fp, '---\ntitle: x\ncwd: /proj\ndependsOn: [833-epics-review-fixes, 834-guard]\n---\n# Goal\nbody\n');
    const p = await prdParser.parsePrdRaw(fp);
    expect(p.dependsOn).toEqual(['833-epics-review-fixes', '834-guard']);

    const fp2 = path.join(dir, '841-y.md');
    fs.writeFileSync(fp2, '---\ntitle: y\ncwd: /proj\ndependsOn: 833-a, ../evil/path, 834-b\n---\n# Goal\nbody\n');
    const p2 = await prdParser.parsePrdRaw(fp2);
    expect(p2.dependsOn).toEqual(['833-a', '834-b']);

    const fp3 = path.join(dir, '842-z.md');
    fs.writeFileSync(fp3, '---\ntitle: z\ncwd: /proj\n---\n# Goal\nbody\n');
    const p3 = await prdParser.parsePrdRaw(fp3);
    expect(p3.dependsOn).toEqual([]);
  });
});

describe('pickForProject dependsOn eligibility (PRD 832)', () => {
  it('holds a job while its dep row is pending/running; releases when completed', () => {
    const dep = job('850-base', 'running', 850);
    const dependent = job('851-next', 'pending', 851, { dependsOn: ['850-base'] });

    // Dep running (tracked in queue rows, not runningSet) — not eligible.
    let res = pickForProject([dep, dependent], new Set(), 3);
    expect(res.batch.map((j) => j.slug)).not.toContain('851-next');

    // Dep completed — eligible.
    res = pickForProject([{ ...dep, status: 'completed' }, dependent], new Set(), 3);
    expect(res.batch.map((j) => j.slug)).toContain('851-next');
  });

  it('a dep slug with NO queue row counts as done (retired to history)', () => {
    const dependent = job('853-next', 'pending', 853, { dependsOn: ['852-archived-long-ago'] });
    const res = pickForProject([dependent], new Set(), 3);
    expect(res.batch.map((j) => j.slug)).toContain('853-next');
  });

  it('a FAILED dep holds the dependent with an explicit depends-gate reason', () => {
    const dep = job('854-base', 'failed', 854);
    const dependent = job('855-next', 'pending', 855, { dependsOn: ['854-base'] });
    const res = pickForProject([dep, dependent], new Set(), 3);
    expect(res.batch).toEqual([]);
    expect(res.reason).toMatch(/depends-gate/);
    expect(res.reason).toContain('855-next');
    expect(res.reason).toContain('854-base');
  });

  it('legacy same-NN pending jobs keep their wave order untouched', () => {
    const a = job('827-one', 'pending', 827);
    const b = job('827-two', 'pending', 827);
    const later = job('828-three', 'pending', 828);
    const res = pickForProject([a, b, later], new Set(), 3);
    expect(res.batch.map((j) => j.slug).sort()).toEqual(['827-one', '827-two']);
  });
});
