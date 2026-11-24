import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyRun, artifactsVerifiedOnDisk, captureArtifactEvidence } = require('../../src/main/runVerify.cjs');
const { commitGuardVerdict } = require('../../src/main/scheduler.cjs');

const SLUG = '816-artifact-prd';
const ART = 'review-records/a.patch';

let tmp: string;
let cwd: string;
let runDir: string;

function writePrd(frontmatter: string) {
  const p = path.join(tmp, 'prd.md');
  fs.writeFileSync(p, `---\ntitle: t\n${frontmatter}---\n\n# Goal\n\nnothing\n`);
  return p;
}
function writeArt(rel: string, content: string, mtime?: Date) {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  if (mtime) fs.utimesSync(abs, mtime, mtime);
}
function writeIn(root: string, rel: string, content: string) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function run(prdPath: string, startedAt: string, finishedAt: string, artifactEvidence: unknown = undefined) {
  fs.writeFileSync(
    path.join(runDir, `${SLUG}.log`),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done\nSCHEDULER_VERDICT: PASS' }) + '\n',
  );
  return verifyRun({
    runDir, prdPath, exitCode: 0, committedDuringRun: false,
    queueEntry: { slug: SLUG, cwd, startedAt, finishedAt },
    ...(artifactEvidence === undefined ? {} : { artifactEvidence }),
  });
}

const DECL = `deliverable: artifact\nartifactPaths: [${ART}, review-records/b.md]\n`;

describe('artifact-only verdict', () => {
  let started: string;
  let finished: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artv-'));
    cwd = path.join(tmp, 'proj');
    runDir = path.join(tmp, 'run');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    started = new Date(Date.now() - 5 * 60_000).toISOString();
    finished = new Date().toISOString();
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('(a) present, non-empty, in-window → artifact_verified', async () => {
    writeArt(ART, 'x'); writeArt('review-records/b.md', 'y');
    const v = await run(writePrd(DECL), started, finished);
    expect(v.verdict).toBe('pass_no_commit_artifact_verified');
    expect(v.verifiedArtifacts).toHaveLength(2);
  });
  it('(b) one artifact missing → pass_no_commit', async () => {
    writeArt(ART, 'x');
    expect((await run(writePrd(DECL), started, finished)).verdict).toBe('pass_no_commit');
  });
  it('(c) zero-byte artifact → pass_no_commit', async () => {
    writeArt(ART, 'x'); writeArt('review-records/b.md', '');
    expect((await run(writePrd(DECL), started, finished)).verdict).toBe('pass_no_commit');
  });
  it('(d) mtime before run window → pass_no_commit', async () => {
    writeArt(ART, 'x'); writeArt('review-records/b.md', 'y', new Date(Date.now() - 3_600_000));
    expect((await run(writePrd(DECL), started, finished)).verdict).toBe('pass_no_commit');
  });
  it('(e) no declaration + same files → pass_no_commit', async () => {
    writeArt(ART, 'x'); writeArt('review-records/b.md', 'y');
    expect((await run(writePrd(''), started, finished)).verdict).toBe('pass_no_commit');
  });
  it('helper rejects unsafe paths and never throws', () => {
    writeArt(ART, 'x');
    const base = { cwd, startedAt: started, finishedAt: finished };
    expect(artifactsVerifiedOnDisk({ ...base, paths: [] })).toBe(false);
    expect(artifactsVerifiedOnDisk({ ...base, paths: ['../x'] })).toBe(false);
    expect(artifactsVerifiedOnDisk({ ...base, paths: ['/etc/passwd'] })).toBe(false);
    expect(artifactsVerifiedOnDisk({ ...base, paths: [''] })).toBe(false);
    // Outside the job worktree: a directory holding a fresh, non-empty file
    // still fails whether named absolutely, via '..', or as the root itself.
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'leak.md'), 'z');
    writeArt('root-file.md', 'r');
    expect(artifactsVerifiedOnDisk({ ...base, paths: [outside] })).toBe(false);
    expect(artifactsVerifiedOnDisk({ ...base, paths: [path.join(outside, 'leak.md')] })).toBe(false);
    expect(artifactsVerifiedOnDisk({ ...base, paths: ['../outside/'] })).toBe(false);
    expect(artifactsVerifiedOnDisk({ ...base, paths: ['review-records/../../outside'] })).toBe(false);
    expect(artifactsVerifiedOnDisk({ ...base, paths: ['.'] })).toBe(false);
    expect(artifactsVerifiedOnDisk({ ...base, paths: ['./'] })).toBe(false);
    // A directory INSIDE the worktree verifies via a fresh direct child (d29a8bfd);
    // one with no fresh non-empty child does not.
    expect(artifactsVerifiedOnDisk({ ...base, paths: ['review-records'] })).toBe(true);
    writeArt('stale-dir/old.md', 'o', new Date(Date.now() - 3_600_000));
    writeArt('stale-dir/empty.md', '');
    expect(artifactsVerifiedOnDisk({ ...base, paths: ['stale-dir/'] })).toBe(false);
    expect(artifactsVerifiedOnDisk({ ...base, paths: [ART], fsImpl: { statSync() { throw new Error('boom'); } } })).toBe(false);
    expect(artifactsVerifiedOnDisk({ ...base, paths: ['review-records'], fsImpl: { statSync: fs.statSync, readdirSync() { throw new Error('boom'); } } })).toBe(false);
    expect(artifactsVerifiedOnDisk({ ...base, paths: [ART] })).toBe(true);
  });
  it('(g) artifact only in a worktree, captured before teardown → artifact_verified (pre-teardown)', async () => {
    const wt = path.join(tmp, 'wt');
    writeIn(wt, ART, 'x'); writeIn(wt, 'review-records/b.md', 'y');
    const prd = writePrd(DECL);
    const ev = captureArtifactEvidence({ prdPath: prd, roots: [cwd, wt], startedAt: started });
    expect(ev?.ok).toBe(true);
    expect(ev?.paths).toEqual([ART, 'review-records/b.md']);
    expect(typeof ev?.capturedAt).toBe('string');
    fs.rmSync(wt, { recursive: true, force: true });
    const v = await run(prd, started, finished, ev);
    expect(v.verdict).toBe('pass_no_commit_artifact_verified');
    expect(v.artifactEvidenceSource).toBe('pre-teardown');
    expect(v.verifiedArtifacts).toEqual(ev.verified);
    expect(v.reason).toMatch(/before teardown/);
  });
  it('(h) worktree deleted, no evidence → pass_no_commit', async () => {
    const wt = path.join(tmp, 'wt');
    writeIn(wt, ART, 'x'); writeIn(wt, 'review-records/b.md', 'y');
    fs.rmSync(wt, { recursive: true, force: true });
    expect((await run(writePrd(DECL), started, finished)).verdict).toBe('pass_no_commit');
  });
  it('(i) ok evidence whose paths differ from the frontmatter → pass_no_commit', async () => {
    const ev = { ok: true, verified: [{ path: ART, size: 1, mtime: finished }], paths: [ART], capturedAt: finished };
    expect((await run(writePrd(DECL), started, finished, ev)).verdict).toBe('pass_no_commit');
    const reordered = { ...ev, paths: ['review-records/b.md', ART] };
    expect((await run(writePrd(DECL), started, finished, reordered)).verdict).toBe('pass_no_commit');
  });
  it('(j) no declaration + ok evidence → pass_no_commit', async () => {
    const ev = { ok: true, verified: [], paths: [ART, 'review-records/b.md'], capturedAt: finished };
    expect((await run(writePrd(''), started, finished, ev)).verdict).toBe('pass_no_commit');
  });
  it('(k) captureArtifactEvidence → null for an undeclared PRD and a missing prdPath', () => {
    writeArt(ART, 'x');
    expect(captureArtifactEvidence({ prdPath: writePrd(''), roots: [cwd], startedAt: started })).toBeNull();
    expect(captureArtifactEvidence({ prdPath: path.join(tmp, 'nope.md'), roots: [cwd], startedAt: started })).toBeNull();
    expect(captureArtifactEvidence({ prdPath: undefined, roots: [cwd], startedAt: started })).toBeNull();
  });
  it('(f) commit guard stands down only on a clean tree', () => {
    const base = { siblingRunning: false, ranInWorktree: true, jobSelfCommitted: false, legitimateNoOp: false, isFixPlanJob: false, artifactVerified: true, verifyResult: { verdict: 'pass_no_commit_artifact_verified' } };
    expect(commitGuardVerdict({ ...base, newlyDirty: ['src/x.ts'] })?.verdict).toBe('uncommitted_changes');
    expect(commitGuardVerdict({ ...base, newlyDirty: [] })).toBeNull();
  });
});
