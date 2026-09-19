// cwdClassify.cjs — one classifier for "what project is this path", failing
// CLOSED on the unprovable worktree case. Fixtures live under a per-run
// mkdtemp sandbox, never the live roots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyCwd, nearestGitEntry, worktreeMainRootOf } = require('../cwdClassify.cjs');
const { assertOpsWrite, resolveOpsRoot } = require('../opsOwnership.cjs');
const { isEphemeralCwd } = require('../ephemeralCwd.cjs');
const { projectRootOf } = require('../activeSessions.cjs');

const OPS = 'session-manager-operations';
let sandbox;
const real = (p) => fs.realpathSync(p);

beforeEach(() => { sandbox = real(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cwdclassify-'))); });
afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

function mkWorktree({ backRef = true } = {}) {
  const main = path.join(sandbox, 'main');
  const wt = path.join(sandbox, 'wt');
  const admin = path.join(main, '.git', 'worktrees', 'wt1');
  fs.mkdirSync(admin, { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${admin}\n`);
  if (backRef) fs.writeFileSync(path.join(admin, 'gitdir'), `${path.join(wt, '.git')}\n`);
  return { main, wt };
}

test('healthy worktree → worktree, projectRoot is the main tree', () => {
  const { main, wt } = mkWorktree();
  const c = classifyCwd(wt);
  assert.equal(c.kind, 'worktree');
  assert.equal(c.projectRoot, main);
  assert.equal(projectRootOf(wt), main);
  assert.equal(isEphemeralCwd(wt), true);
  assert.equal(worktreeMainRootOf(wt), main);
});

test('broken back-reference → unknown; ops writes refused, resolution and dispatch stay open', () => {
  const { wt } = mkWorktree({ backRef: false });
  const c = classifyCwd(wt);
  assert.equal(c.kind, 'unknown');
  assert.equal(c.projectRoot, wt);
  assert.match(c.reason, /back-reference/);
  assert.equal(projectRootOf(wt), wt); // total — never throws
  assert.equal(resolveOpsRoot(wt), path.join(wt, OPS)); // reads/dispatch unaffected
  assert.throws(
    () => assertOpsWrite(path.join(wt, OPS, 'scheduler', 'state', 'queue.json'), 'scheduler'),
    (e) => e.unknownCwd === true && /back-reference/.test(e.message),
  );
});

test('garbled .git file → unknown', () => {
  const dir = path.join(sandbox, 'garbled');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.git'), 'not a pointer\n');
  assert.equal(classifyCwd(dir).kind, 'unknown');
});

test('separate-git-dir → project (gitdir not under worktrees/)', () => {
  const dir = path.join(sandbox, 'sep');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(sandbox, 'elsewhere.git')}\n`);
  const c = classifyCwd(dir);
  assert.equal(c.kind, 'project');
  assert.equal(c.projectRoot, dir);
  assert.doesNotThrow(() => assertOpsWrite(path.join(dir, OPS, 'scheduler', 'state', 'queue.json'), 'scheduler'));
});

test('submodule (relative gitdir) → project rooted at the submodule', () => {
  const sup = path.join(sandbox, 'super');
  const sub = path.join(sup, 'libs', 'sub');
  fs.mkdirSync(path.join(sup, '.git', 'modules', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(sub, 'src'), { recursive: true });
  fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../../.git/modules/sub\n');
  const c = classifyCwd(path.join(sub, 'src'));
  assert.equal(c.kind, 'project');
  assert.equal(c.projectRoot, sub);
});

test('plain project (.git dir, and no git at all) → project', () => {
  const proj = path.join(sandbox, 'proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'src'));
  assert.deepEqual(
    { k: classifyCwd(path.join(proj, 'src')).kind, r: classifyCwd(path.join(proj, 'src')).projectRoot },
    { k: 'project', r: proj },
  );
  const bare = path.join(sandbox, 'nogit');
  fs.mkdirSync(bare);
  assert.equal(classifyCwd(bare).projectRoot, bare);
  assert.equal(nearestGitEntry(bare), null);
});

test('nested ops root: outermost (indexOf) and innermost (lastIndexOf) are both reported, neither unified', () => {
  const proj = path.join(sandbox, 'proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  const nested = path.join(proj, OPS, 'scheduler', 'prds', OPS, 'scheduler', 'state');
  const c = classifyCwd(nested);
  assert.equal(c.projectRoot, proj);
  assert.equal(c.outermostOpsRoot, path.join(proj, OPS));
  assert.equal(c.innermostOpsRoot, path.join(proj, OPS, 'scheduler', 'prds', OPS));
  assert.equal(classifyCwd(proj).outermostOpsRoot, null);
});

test('ephemeral: os.tmpdir() itself', () => {
  assert.equal(classifyCwd(path.resolve(os.tmpdir())).kind, 'ephemeral');
  assert.equal(isEphemeralCwd(os.tmpdir()), true);
});
