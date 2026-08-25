'use strict';

/**
 * audit-ops-hygiene-pattern-f.test.cjs — Pattern F of audit-ops-hygiene.cjs:
 * the referential-integrity pass over the Agent/WorkType/Epic/PRD/Job ERD's
 * unvalidated-string foreign keys.
 *
 * "Throw on write, report on read" — epicMint.cjs's ensureEpic (see
 * epicMint.test.cjs) refuses to MINT a bad agentType reference. This pass
 * covers the other half: a reference that was valid at creation and later
 * went dangling (persona renamed/deleted, Epic archived) is legitimate
 * history, so it's only ever REPORTED here, never repaired.
 *
 * Spawned as a real subprocess, matching the pattern-e test's rationale:
 * the script's path constants are derived once from `process.argv[2]` at
 * module load.
 *
 * Run: timeout 120 npx vitest run scripts/__tests__/audit-ops-hygiene-pattern-f.test.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'audit-ops-hygiene.cjs');

function newProjectCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hygiene-pattern-f-'));
}

function writeActiveIndex(cwd, sessions) {
  const dir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify({ sessions, events: {} }, null, 2));
}

function writeQueue(cwd, jobs) {
  const dir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ jobs }, null, 2));
}

function writePersona(cwd, name) {
  const dir = path.join(cwd, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\n---\nbody\n`);
}

function runAudit(cwd) {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hygiene-out-')), 'result.json');
  const auditLogPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hygiene-auditlog-')), 'audit-log.jsonl');
  execFileSync(process.execPath, [SCRIPT, cwd], {
    env: { ...process.env, AUDIT_JSON_OUT: outFile, SM_AUDIT_LOG_PATH_OVERRIDE: auditLogPath },
  });
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}

test('flags an Epic whose agentType no longer resolves to a persona file', () => {
  const cwd = newProjectCwd();
  writeActiveIndex(cwd, {
    'epic-1': { id: 'epic-1', status: 'proposed', agentType: 'deleted-persona' },
  });

  const result = runAudit(cwd);

  expect(result.patternF.danglingAgentTypeCount).toBe(1);
  expect(result.patternF.danglingAgentType[0]).toEqual({ epicId: 'epic-1', agentType: 'deleted-persona' });
  expect(result.patternF.verdict).toMatch(/INVESTIGATE/);
});

test('does NOT flag an Epic whose agentType resolves via the project overlay', () => {
  const cwd = newProjectCwd();
  writePersona(cwd, 'overlay-persona');
  writeActiveIndex(cwd, {
    'epic-1': { id: 'epic-1', status: 'proposed', agentType: 'overlay-persona' },
  });

  const result = runAudit(cwd);

  expect(result.patternF.danglingAgentTypeCount).toBe(0);
});

test('flags an Epic whose tag is outside the WorkType union', () => {
  const cwd = newProjectCwd();
  writeActiveIndex(cwd, {
    'epic-1': { id: 'epic-1', status: 'proposed', tag: 'not-a-real-worktype' },
  });

  const result = runAudit(cwd);

  expect(result.patternF.invalidTagCount).toBe(1);
  expect(result.patternF.invalidTag[0]).toEqual({ epicId: 'epic-1', tag: 'not-a-real-worktype' });
});

test('does NOT flag an Epic whose tag is a real WorkType', () => {
  const cwd = newProjectCwd();
  writeActiveIndex(cwd, {
    'epic-1': { id: 'epic-1', status: 'proposed', tag: 'feature' },
  });

  const result = runAudit(cwd);

  expect(result.patternF.invalidTagCount).toBe(0);
});

test('flags a queue row whose epicId or sourcePromptId names an Epic absent from active-index.json', () => {
  const cwd = newProjectCwd();
  writeActiveIndex(cwd, {
    'epic-1': { id: 'epic-1', status: 'proposed' },
  });
  writeQueue(cwd, [
    { slug: 'job-a', epicId: 'epic-1', sourcePromptId: null },
    { slug: 'job-b', epicId: 'epic-missing', sourcePromptId: null },
    { slug: 'job-c', epicId: null, sourcePromptId: 'also-missing' },
  ]);

  const result = runAudit(cwd);

  expect(result.patternF.danglingJobRefCount).toBe(2);
  expect(result.patternF.danglingJobRefs).toEqual(
    expect.arrayContaining([
      { jobId: 'job-b', field: 'epicId', value: 'epic-missing' },
      { jobId: 'job-c', field: 'sourcePromptId', value: 'also-missing' },
    ]),
  );
});

test('reports CLEAN when every reference resolves', () => {
  const cwd = newProjectCwd();
  writePersona(cwd, 'architect');
  writeActiveIndex(cwd, {
    'epic-1': { id: 'epic-1', status: 'proposed', agentType: 'architect', tag: 'feature' },
  });
  writeQueue(cwd, [{ slug: 'job-a', epicId: 'epic-1', sourcePromptId: 'epic-1' }]);

  const result = runAudit(cwd);

  expect(result.patternF.danglingAgentTypeCount).toBe(0);
  expect(result.patternF.invalidTagCount).toBe(0);
  expect(result.patternF.danglingJobRefCount).toBe(0);
  expect(result.patternF.verdict).toMatch(/CLEAN/);
});

test('never repairs or deletes anything — active-index.json and queue.json are byte-identical after the sweep', () => {
  const cwd = newProjectCwd();
  writeActiveIndex(cwd, { 'epic-1': { id: 'epic-1', status: 'proposed', agentType: 'ghost', tag: 'bogus' } });
  writeQueue(cwd, [{ slug: 'job-a', epicId: 'epic-missing' }]);
  const indexPath = path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json');
  const queuePath = path.join(cwd, 'session-manager-operations', 'scheduler', 'state', 'queue.json');
  const indexBefore = fs.readFileSync(indexPath, 'utf8');
  const queueBefore = fs.readFileSync(queuePath, 'utf8');

  runAudit(cwd);

  expect(fs.readFileSync(indexPath, 'utf8')).toBe(indexBefore);
  expect(fs.readFileSync(queuePath, 'utf8')).toBe(queueBefore);
});

test('exit code stays 0 despite findings — advisory only', () => {
  const cwd = newProjectCwd();
  writeActiveIndex(cwd, { 'epic-1': { id: 'epic-1', status: 'proposed', agentType: 'ghost' } });

  expect(() => runAudit(cwd)).not.toThrow();
});
