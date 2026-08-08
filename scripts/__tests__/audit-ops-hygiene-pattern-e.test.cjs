'use strict';

/**
 * audit-ops-hygiene-pattern-e.test.cjs — Pattern E of audit-ops-hygiene.cjs
 * flags an UNTRACKED PRD `.md` file with no matching `prd_create` audit
 * event as a possible hand-authored bypass of `scheduler_create_prd` (this
 * PRD's AC: "audit-ops-hygiene.cjs ... flag a hand-written PRD as a hygiene
 * finding").
 *
 * Deliberately git-status-based, not mtime-based: a PRD `.md` file is
 * committed to the target repo, so `git clone`/`checkout`/`clean` resets any
 * already-committed PRD's mtime to "now" — an earlier mtime-vs-audit-log
 * version of this check would have false-positived on nearly every
 * already-committed PRD after a fresh checkout. Only a file `git status`
 * reports as untracked (`??`) was genuinely just created in this working
 * tree, so that's the only thing checked against the audit log.
 *
 * Spawned as a real subprocess (matching the script's actual CLI contract:
 * `node audit-ops-hygiene.cjs <cwd>`, `AUDIT_JSON_OUT` for machine-readable
 * output) rather than required in-process, since its path constants are
 * derived once from `process.argv[2]` at module load. `SM_AUDIT_LOG_PATH_OVERRIDE`
 * points it at a throwaway audit log instead of the real
 * `~/.claude/session-manager/audit-log.jsonl`.
 *
 * Run: timeout 120 npx vitest run scripts/__tests__/audit-ops-hygiene-pattern-e.test.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'audit-ops-hygiene.cjs');

function newGitProjectCwd() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hygiene-pattern-e-'));
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  // A real repo needs at least one commit for `git status` to behave normally.
  fs.writeFileSync(path.join(cwd, 'README.md'), 'placeholder\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd });
  return cwd;
}

function writePrd(cwd, epicId, filename, { commit } = {}) {
  const dir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epicId, 'prds');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, filename);
  fs.writeFileSync(fp, `---\ntitle: Test\ncwd: ${cwd}\nestimateMinutes: 5\n---\n\n# Goal\n`, 'utf8');
  if (commit) {
    const rel = path.relative(cwd, fp);
    execFileSync('git', ['add', rel], { cwd });
    execFileSync('git', ['commit', '-q', '-m', `add ${filename}`], { cwd });
  }
  return fp;
}

function writeAuditLog(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hygiene-auditlog-'));
  const fp = path.join(dir, 'audit-log.jsonl');
  fs.writeFileSync(fp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return fp;
}

function runAudit(cwd, auditLogPath) {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hygiene-out-')), 'result.json');
  execFileSync(process.execPath, [SCRIPT, cwd], {
    env: { ...process.env, AUDIT_JSON_OUT: outFile, SM_AUDIT_LOG_PATH_OVERRIDE: auditLogPath },
  });
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}

test('flags an untracked PRD with no matching prd_create audit event as unattributed', () => {
  const cwd = newGitProjectCwd();
  writePrd(cwd, 'epic-1', '001-hand-written.md'); // left untracked
  const auditLogPath = writeAuditLog([
    { kind: 'prd_create', cwd, slug: 'some-other-slug', at: new Date().toISOString() },
  ]);

  const result = runAudit(cwd, auditLogPath);

  expect(result.patternE.applicable).toBe(true);
  expect(result.patternE.unattributedCount).toBe(1);
  expect(result.patternE.unattributed[0].slug).toBe('001-hand-written');
  expect(result.patternE.verdict).toMatch(/INVESTIGATE/);
});

test('does NOT flag an untracked PRD with a matching prd_create audit event', () => {
  const cwd = newGitProjectCwd();
  writePrd(cwd, 'epic-1', '002-api-created.md');
  const auditLogPath = writeAuditLog([
    { kind: 'prd_create', cwd, slug: '002-api-created', at: new Date().toISOString() },
  ]);

  const result = runAudit(cwd, auditLogPath);

  expect(result.patternE.unattributedCount).toBe(0);
  expect(result.patternE.verdict).toMatch(/CLEAN/);
});

test('does NOT flag an already-committed PRD, even with no audit record and a fresh (checkout-reset) mtime', () => {
  const cwd = newGitProjectCwd();
  const fp = writePrd(cwd, 'epic-1', '003-committed-legacy.md', { commit: true });
  // Simulate a fresh checkout resetting mtime to "now" — the exact failure
  // mode an earlier mtime-based version of this check would have flagged.
  const now = new Date();
  fs.utimesSync(fp, now, now);
  const auditLogPath = writeAuditLog([]); // no record at all, anywhere

  const result = runAudit(cwd, auditLogPath);

  expect(result.patternE.unattributedCount).toBe(0);
});

test('treats a missing audit log as "nothing ever recorded" — untracked file still flagged (fails safe, not silent)', () => {
  const cwd = newGitProjectCwd();
  writePrd(cwd, 'epic-1', '004-no-log.md');
  const missingLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hygiene-nolog-')), 'nope.jsonl');

  const result = runAudit(cwd, missingLog);

  expect(result.patternE.unattributedCount).toBe(1);
});

test('reports NOT APPLICABLE for a non-git cwd instead of a false CLEAN', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hygiene-nongit-'));
  writePrd(cwd, 'epic-1', '005-no-git.md');
  const auditLogPath = writeAuditLog([]);

  const result = runAudit(cwd, auditLogPath);

  expect(result.patternE.applicable).toBe(false);
  expect(result.patternE.unattributedCount).toBe(0);
  expect(result.patternE.verdict).toMatch(/NOT APPLICABLE/);
});
