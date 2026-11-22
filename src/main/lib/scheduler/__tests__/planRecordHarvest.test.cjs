'use strict';
// Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/planRecordHarvest.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OPS_ROOT_DIR } = require('../../opsOwnership.cjs');
const { harvestPlanRecords, MAX_BYTES } = require('../planRecordHarvest.cjs');

const EPIC = 'abc123-epic';
let tmp;
let worktreeDir;
let projectRoot;

function srcDir(epicId = EPIC) {
  return path.join(worktreeDir, OPS_ROOT_DIR, 'plan-records', epicId);
}
function destDir(epicId = EPIC) {
  return path.join(projectRoot, OPS_ROOT_DIR, 'plan-records', epicId);
}
function writeSrc(name, text, epicId = EPIC) {
  fs.mkdirSync(srcDir(epicId), { recursive: true });
  fs.writeFileSync(path.join(srcDir(epicId), name), text);
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-harvest-')));
  worktreeDir = path.join(tmp, 'worktree');
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(worktreeDir);
  fs.mkdirSync(projectRoot);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('harvestPlanRecords', () => {
  it('copies top-level .md records into the main checkout', () => {
    writeSrc('plan.md', '# Plan\n');
    writeSrc('wave-2.md', 'two\n');
    const res = harvestPlanRecords({ worktreeDir, projectRoot, epicId: EPIC });
    assert.deepEqual(res.skipped, []);
    assert.deepEqual(res.copied, [path.join(destDir(), 'plan.md'), path.join(destDir(), 'wave-2.md')]);
    assert.equal(fs.readFileSync(path.join(destDir(), 'plan.md'), 'utf8'), '# Plan\n');
  });

  it('overwrites an existing record and is idempotent', () => {
    writeSrc('plan.md', 'v1\n');
    harvestPlanRecords({ worktreeDir, projectRoot, epicId: EPIC });
    writeSrc('plan.md', 'v2\n');
    const a = harvestPlanRecords({ worktreeDir, projectRoot, epicId: EPIC });
    const b = harvestPlanRecords({ worktreeDir, projectRoot, epicId: EPIC });
    assert.deepEqual(a, b);
    assert.equal(a.copied.length, 1);
    assert.equal(fs.readFileSync(path.join(destDir(), 'plan.md'), 'utf8'), 'v2\n');
    assert.deepEqual(fs.readdirSync(destDir()), ['plan.md']);
  });

  it('skips symlinks, folders and disallowed names with a reason', () => {
    writeSrc('real.md', 'ok\n');
    const outside = path.join(tmp, 'secret.md');
    fs.writeFileSync(outside, 'secret\n');
    fs.symlinkSync(outside, path.join(srcDir(), 'link.md'));
    fs.mkdirSync(path.join(srcDir(), 'sub.md'));
    writeSrc('notes.txt', 'x');
    writeSrc('bad name.md', 'x');
    const res = harvestPlanRecords({ worktreeDir, projectRoot, epicId: EPIC });
    assert.deepEqual(res.copied, [path.join(destDir(), 'real.md')]);
    const reasons = Object.fromEntries(res.skipped.map((s) => [path.basename(s.path), s.reason]));
    assert.equal(reasons['link.md'], 'symlink');
    assert.equal(reasons['sub.md'], 'directory');
    assert.equal(reasons['notes.txt'], 'name not allowed');
    assert.equal(reasons['bad name.md'], 'name not allowed');
    assert.equal(fs.existsSync(path.join(destDir(), 'link.md')), false);
  });

  it('skips files over 1 MiB', () => {
    writeSrc('big.md', 'a'.repeat(MAX_BYTES + 1));
    writeSrc('edge.md', 'a'.repeat(MAX_BYTES));
    const res = harvestPlanRecords({ worktreeDir, projectRoot, epicId: EPIC });
    assert.deepEqual(res.copied, [path.join(destDir(), 'edge.md')]);
    assert.equal(res.skipped.length, 1);
    assert.match(res.skipped[0].reason, /^oversize/);
    assert.equal(fs.existsSync(path.join(destDir(), 'big.md')), false);
  });

  it('refuses an unsafe epicId without touching disk', () => {
    for (const epicId of ['../escape', 'Upper', '-lead', '', 'a/b', undefined]) {
      const res = harvestPlanRecords({ worktreeDir, projectRoot, epicId });
      assert.deepEqual(res.copied, []);
      assert.equal(res.skipped.length, 1);
      assert.equal(res.skipped[0].reason, 'unsafe epicId');
    }
    assert.equal(fs.existsSync(path.join(projectRoot, OPS_ROOT_DIR)), false);
  });

  it('is a no-op when worktreeDir equals projectRoot', () => {
    fs.mkdirSync(path.join(projectRoot, OPS_ROOT_DIR, 'plan-records', EPIC), { recursive: true });
    fs.writeFileSync(path.join(destDir(), 'plan.md'), 'x');
    const res = harvestPlanRecords({ worktreeDir: projectRoot, projectRoot, epicId: EPIC });
    assert.deepEqual(res, { copied: [], skipped: [] });
  });

  it('returns an empty result when the source folder is missing', () => {
    const res = harvestPlanRecords({ worktreeDir, projectRoot, epicId: EPIC });
    assert.deepEqual(res, { copied: [], skipped: [] });
    assert.equal(fs.existsSync(destDir()), false);
  });

  it('never throws when the injected fs fails', () => {
    writeSrc('plan.md', 'x');
    const fsImpl = { ...fs, readFileSync: () => { throw new Error('boom'); } };
    const res = harvestPlanRecords({ worktreeDir, projectRoot, epicId: EPIC, fsImpl });
    assert.deepEqual(res.copied, []);
    assert.match(res.skipped[0].reason, /copy failed: boom/);
  });
});
