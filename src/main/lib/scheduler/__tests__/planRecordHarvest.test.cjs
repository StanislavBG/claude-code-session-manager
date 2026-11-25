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

describe('harvestPlanRecords declaredPaths', () => {
  const FOREIGN = 'parent-epic-f93dac99';
  const rel = (folder, name) => `${OPS_ROOT_DIR}/plan-records/${folder}/${name}`;

  it('(a) copies a declared record from a foreign epic folder', () => {
    writeSrc('validate.md', '# V\n', FOREIGN);
    const res = harvestPlanRecords({ worktreeDir, projectRoot, epicId: EPIC, declaredPaths: [rel(FOREIGN, 'validate.md')] });
    assert.deepEqual(res.skipped, []);
    assert.deepEqual(res.copied, [path.join(destDir(FOREIGN), 'validate.md')]);
    assert.equal(fs.readFileSync(path.join(destDir(FOREIGN), 'validate.md'), 'utf8'), '# V\n');
  });

  it('(b) skips malformed or escaping declared paths and writes nothing', () => {
    writeSrc('x.md', 'x', FOREIGN);
    fs.mkdirSync(path.join(srcDir(FOREIGN), 'sub'), { recursive: true });
    fs.writeFileSync(path.join(srcDir(FOREIGN), 'sub', 'y.md'), 'y');
    const bad = [
      `${OPS_ROOT_DIR}/plan-records/../plan-records/${FOREIGN}/x.md`,
      `${OPS_ROOT_DIR}/plan-records/${FOREIGN}/../${FOREIGN}/x.md`,
      rel('Bad_Folder', 'x.md'),
      rel(FOREIGN, 'x.txt'),
      rel(FOREIGN, 'sub/y.md'),
      `${OPS_ROOT_DIR}/plan-records/${FOREIGN}/x.md\0`,
      'src/main/x.md',
      42,
    ];
    const res = harvestPlanRecords({ worktreeDir, projectRoot, epicId: EPIC, declaredPaths: bad });
    assert.deepEqual(res.copied, []);
    assert.equal(res.skipped.length, bad.length);
    for (const sk of res.skipped) assert.ok(sk.reason && typeof sk.reason === 'string');
    assert.equal(fs.existsSync(path.join(projectRoot, OPS_ROOT_DIR)), false);
  });

  it('(c) reports a declared but missing record', () => {
    const res = harvestPlanRecords({ worktreeDir, projectRoot, epicId: EPIC, declaredPaths: [rel(FOREIGN, 'gone.md')] });
    assert.deepEqual(res.copied, []);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].reason, 'declared plan record not found in worktree');
  });

  it('(d) copies a record in the own folder that is also declared exactly once', () => {
    writeSrc('plan.md', 'p');
    const res = harvestPlanRecords({ worktreeDir, projectRoot, epicId: EPIC, declaredPaths: [rel(EPIC, 'plan.md'), `./${rel(EPIC, 'plan.md')}`] });
    assert.deepEqual(res.skipped, []);
    assert.deepEqual(res.copied, [path.join(destDir(), 'plan.md')]);
  });

  it('(e) skips a symlinked declared record', () => {
    const outside = path.join(tmp, 'secret.md');
    fs.writeFileSync(outside, 'secret');
    fs.mkdirSync(srcDir(FOREIGN), { recursive: true });
    fs.symlinkSync(outside, path.join(srcDir(FOREIGN), 'link.md'));
    const res = harvestPlanRecords({ worktreeDir, projectRoot, epicId: EPIC, declaredPaths: [rel(FOREIGN, 'link.md')] });
    assert.deepEqual(res.copied, []);
    assert.equal(res.skipped[0].reason, 'symlink');
    assert.equal(fs.existsSync(path.join(destDir(FOREIGN), 'link.md')), false);
  });
  it('(f) skips a declared record whose epic folder is a symlink', () => {
    const outsideDir = path.join(tmp, 'outside-folder');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'leak.md'), 'leak');
    fs.mkdirSync(path.dirname(srcDir(FOREIGN)), { recursive: true });
    fs.symlinkSync(outsideDir, srcDir(FOREIGN));
    const res = harvestPlanRecords({ worktreeDir, projectRoot, epicId: EPIC, declaredPaths: [rel(FOREIGN, 'leak.md')] });
    assert.deepEqual(res.copied, []);
    assert.equal(res.skipped[0].reason, 'declared epic folder is not a directory');
    assert.equal(fs.existsSync(path.join(destDir(FOREIGN), 'leak.md')), false);
  });

  it('(g) an unsafe epicId still copies a valid declared record and reports the epicId skip', () => {
    writeSrc('validate.md', '# V\n', FOREIGN);
    const res = harvestPlanRecords({ worktreeDir, projectRoot, epicId: '../escape', declaredPaths: [rel(FOREIGN, 'validate.md')] });
    assert.deepEqual(res.copied, [path.join(destDir(FOREIGN), 'validate.md')]);
    assert.deepEqual(res.skipped, [{ path: '../escape', reason: 'unsafe epicId' }]);
    assert.equal(fs.readFileSync(path.join(destDir(FOREIGN), 'validate.md'), 'utf8'), '# V\n');
  });

  it('(h) an unsafe epicId with no declared paths copies nothing', () => {
    writeSrc('plan.md', 'p', 'Upper');
    const res = harvestPlanRecords({ worktreeDir, projectRoot, epicId: 'Upper', declaredPaths: [] });
    assert.deepEqual(res.copied, []);
    assert.deepEqual(res.skipped, [{ path: 'Upper', reason: 'unsafe epicId' }]);
    assert.equal(fs.existsSync(path.join(projectRoot, OPS_ROOT_DIR)), false);
  });
});
