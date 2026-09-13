'use strict';

/**
 * ops-sweep-claude-md-fallback.test.cjs — covers scripts/ops-sweep.cjs's two
 * newest checks (PRD: session-manager-operations/CLAUDE.md as a scoped home
 * for the single-writer OWNERS enumeration):
 *
 *   1. Ownership-doc fallback: the UNDOCUMENTED/CONTRADICTION checks read
 *      `<cwd>/session-manager-operations/CLAUDE.md` when it exists, and fall
 *      back to `<cwd>/CLAUDE.md` when it doesn't — so a project that hasn't
 *      split its ops docs out yet keeps working unchanged.
 *   2. NESTED_CLAUDE_MD_OVER_BUDGET: any CLAUDE.md strictly below the repo
 *      root (excluding node_modules) over 4000 bytes is flagged, and the
 *      root CLAUDE.md itself is exempt from this check.
 *
 * Spawned as a real subprocess, matching the script's actual CLI contract
 * (`node ops-sweep.cjs <target-project-cwd>`, JSON on stdout).
 *
 * Run: timeout 120 npx vitest run scripts/__tests__/ops-sweep-claude-md-fallback.test.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'ops-sweep.cjs');

function newProjectCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-ops-sweep-'));
}

function writeNamespace(cwd, name, { readme } = {}) {
  const dir = path.join(cwd, 'session-manager-operations', name);
  fs.mkdirSync(dir, { recursive: true });
  if (readme != null) fs.writeFileSync(path.join(dir, 'README.md'), readme, 'utf8');
}

function runSweep(cwd) {
  const out = execFileSync(process.execPath, [SCRIPT, cwd], { encoding: 'utf8' });
  return JSON.parse(out);
}

test('falls back to root CLAUDE.md when no scoped ops CLAUDE.md exists', () => {
  const cwd = newProjectCwd();
  writeNamespace(cwd, 'scheduler', { readme: '# Scheduler\n' });
  fs.writeFileSync(
    path.join(cwd, 'CLAUDE.md'),
    '# Root\n\n`scheduler` is OWNERS-governed.\n',
    'utf8',
  );

  const report = runSweep(cwd);

  expect(report.ownershipDocPath).toBe('CLAUDE.md');
  const findingTypes = report.findings.map((f) => f.type);
  expect(findingTypes).not.toContain('UNDOCUMENTED');
});

test('prefers session-manager-operations/CLAUDE.md over root CLAUDE.md when both exist', () => {
  const cwd = newProjectCwd();
  writeNamespace(cwd, 'scheduler', { readme: '# Scheduler\n' });
  // Root CLAUDE.md never mentions `scheduler` at all — if the fallback wrongly
  // preferred this file, the namespace would report UNDOCUMENTED.
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# Root\n\nnothing relevant here.\n', 'utf8');
  fs.writeFileSync(
    path.join(cwd, 'session-manager-operations', 'CLAUDE.md'),
    '# session-manager-operations/ — scoped context\n\n`scheduler` is OWNERS-governed.\n',
    'utf8',
  );

  const report = runSweep(cwd);

  expect(report.ownershipDocPath).toBe(path.join('session-manager-operations', 'CLAUDE.md'));
  const findingTypes = report.findings.map((f) => f.type);
  expect(findingTypes).not.toContain('UNDOCUMENTED');
});

test('a namespace absent from the scoped ops CLAUDE.md is flagged UNDOCUMENTED even though root CLAUDE.md mentions it', () => {
  const cwd = newProjectCwd();
  writeNamespace(cwd, 'scheduler', { readme: '# Scheduler\n' });
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# Root\n\n`scheduler` is OWNERS-governed.\n', 'utf8');
  fs.writeFileSync(
    path.join(cwd, 'session-manager-operations', 'CLAUDE.md'),
    '# session-manager-operations/ — scoped context\n\nno namespace mentions here.\n',
    'utf8',
  );

  const report = runSweep(cwd);

  const schedulerFindings = report.namespaces.find((n) => n.name === 'scheduler').findings;
  expect(schedulerFindings.map((f) => f.type)).toContain('UNDOCUMENTED');
});

test('flags a nested CLAUDE.md over the 4000-byte cap, excludes node_modules, and exempts the root file', () => {
  const cwd = newProjectCwd();
  writeNamespace(cwd, 'scheduler', { readme: '# Scheduler\n' });

  // Root CLAUDE.md: oversized relative to the nested cap, but must NOT be
  // flagged as NESTED_CLAUDE_MD_OVER_BUDGET — it's the root law file, not a
  // nested scoped-context note.
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '#'.repeat(5000), 'utf8');

  // Oversized nested CLAUDE.md — must be flagged.
  fs.mkdirSync(path.join(cwd, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'plugins', 'CLAUDE.md'), '#'.repeat(4500), 'utf8');

  // Oversized CLAUDE.md inside node_modules — must be excluded.
  fs.mkdirSync(path.join(cwd, 'node_modules', 'some-pkg'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'node_modules', 'some-pkg', 'CLAUDE.md'), '#'.repeat(4500), 'utf8');

  // Undersized nested CLAUDE.md — must not be flagged.
  fs.mkdirSync(path.join(cwd, 'web-remote'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'web-remote', 'CLAUDE.md'), '# small\n', 'utf8');

  const report = runSweep(cwd);

  expect(report.nestedClaudeMdFiles.sort()).toEqual(
    [path.join('plugins', 'CLAUDE.md'), path.join('web-remote', 'CLAUDE.md')].sort(),
  );
  const overBudget = report.findings.filter((f) => f.type === 'NESTED_CLAUDE_MD_OVER_BUDGET');
  expect(overBudget).toHaveLength(1);
  expect(overBudget[0].file).toBe(path.join('plugins', 'CLAUDE.md'));
});
