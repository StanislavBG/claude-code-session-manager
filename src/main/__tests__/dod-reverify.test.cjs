/**
 * dod-reverify.test.cjs — unit tests for extractAcCommand / reverifyAc / reverifyBatch.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/dod-reverify.test.cjs
 *
 * Fixtures: os.tmpdir() only — never touches the real prds dir or scheduler queue.
 */

'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { extractAcCommand, reverifyAc, reverifyBatch, runGateSequence } = require('../lib/definitionOfDone.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dod-reverify-test-'));
}

function rmdir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

/** Write a minimal PRD file under `dir` (created if missing) and return the job object. */
function writePrd(dir, slug, acLine, cwd) {
  const body = [
    '---',
    `title: ${slug}`,
    `cwd: ${cwd}`,
    'estimateMinutes: 5',
    '---',
    '',
    '# Goal',
    '',
    'Test fixture.',
    '',
    '# Acceptance criteria',
    '',
    acLine,
    '',
    '# Out of scope',
    '',
    '- N/A',
  ].join('\n');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.md`), body);
  return { slug, cwd };
}

/** The common-case resolver: the PRD always lives in one fixed dir. */
function resolverFor(dir) {
  return (job) => path.join(dir, `${job.slug}.md`);
}

// ─── extractAcCommand: backtick-quoted timeout ─────────────────────────────

test('extractAcCommand: extracts timeout from backtick-quoted inline code', () => {
  const body = [
    '# Acceptance criteria',
    '',
    '- [ ] Test `timeout 120 node --test src/main/__tests__/foo.test.cjs` passes.',
  ].join('\n');
  assert.strictEqual(extractAcCommand(body), 'timeout 120 node --test src/main/__tests__/foo.test.cjs');
});

test('extractAcCommand: extracts timeout from raw (non-backtick) AC line', () => {
  const body = [
    '# Acceptance criteria',
    '',
    '- [ ] timeout 60 node -c src/main/lib/definitionOfDone.cjs',
  ].join('\n');
  assert.strictEqual(extractAcCommand(body), 'timeout 60 node -c src/main/lib/definitionOfDone.cjs');
});

test('extractAcCommand: returns first timeout command when multiple AC lines match', () => {
  const body = [
    '# Acceptance criteria',
    '',
    '- [ ] `timeout 60 node -c foo.cjs` parses clean.',
    '- [ ] `timeout 120 node --test bar.test.cjs` passes.',
  ].join('\n');
  assert.strictEqual(extractAcCommand(body), 'timeout 60 node -c foo.cjs');
});

test('extractAcCommand: returns null when no timeout command in AC section', () => {
  const body = [
    '# Acceptance criteria',
    '',
    '- [ ] The widget renders without errors.',
    '- [ ] The config file is valid JSON.',
  ].join('\n');
  assert.strictEqual(extractAcCommand(body), null);
});

test('extractAcCommand: returns null for null/empty body', () => {
  assert.strictEqual(extractAcCommand(null), null);
  assert.strictEqual(extractAcCommand(''), null);
  assert.strictEqual(extractAcCommand(undefined), null);
});

test('extractAcCommand: skips commands with shell pipes (needs shell:true)', () => {
  const body = [
    '# Acceptance criteria',
    '',
    '- [ ] `timeout 150 python -m pytest 2>&1 | tail -15` passes.',
    '- [ ] `timeout 60 node -c src/lib/foo.cjs` parses clean.',
  ].join('\n');
  // Pipe command is rejected; falls back to the second clean command.
  assert.strictEqual(extractAcCommand(body), 'timeout 60 node -c src/lib/foo.cjs');
});

test('extractAcCommand: works when body contains frontmatter strip artifact', () => {
  const body = [
    '# Goal',
    '',
    'Do something.',
    '',
    '# Acceptance criteria',
    '',
    '- [ ] `timeout 30 node --test tests/foo.test.cjs` passes.',
  ].join('\n');
  assert.strictEqual(extractAcCommand(body), 'timeout 30 node --test tests/foo.test.cjs');
});

// ─── reverifyAc: finds the PRD via the injected resolver, no prdsDir ─────────

test('reverifyAc: finds the PRD under scheduler/epics/<id>/prds via the resolver and runs a green gate', async () => {
  const tmpDir = makeTmpDir();
  const cwd = path.join(tmpDir, 'project');
  // Mirrors the real on-disk shape (session-manager-operations/scheduler/epics/<id>/prds) —
  // reverifyAc itself never joins this path; it only calls whatever resolver it is given.
  const liveDir = path.join(tmpDir, 'session-manager-operations', 'scheduler', 'epics', 'epic-1', 'prds');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'ok.cjs'), 'process.exit(0);');

  const job = writePrd(liveDir, '101-pass', '- [ ] `timeout 10 node ok.cjs` succeeds.', cwd);
  try {
    const result = await reverifyAc(job, { resolvePrdPath: resolverFor(liveDir) });
    assert.strictEqual(result.slug, '101-pass');
    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.code, 0);
    assert.ok(typeof result.ms === 'number' && result.ms >= 0, `ms should be >= 0, got ${result.ms}`);
  } finally {
    rmdir(tmpDir);
  }
});

test('reverifyAc: returns fail when AC command exits non-zero', async () => {
  const tmpDir = makeTmpDir();
  const cwd = path.join(tmpDir, 'project');
  const liveDir = path.join(tmpDir, 'prds');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'fail.cjs'), 'process.exit(1);');

  const job = writePrd(liveDir, '102-fail', '- [ ] `timeout 10 node fail.cjs` succeeds.', cwd);
  try {
    const result = await reverifyAc(job, { resolvePrdPath: resolverFor(liveDir) });
    assert.strictEqual(result.slug, '102-fail');
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.code, 1);
    assert.ok(typeof result.ms === 'number' && result.ms >= 0);
  } finally {
    rmdir(tmpDir);
  }
});

// ─── reverifyAc: archived-twin fallback ──────────────────────────────────────

test('reverifyAc: runs the gate when the resolver falls back to the archived PRD', async () => {
  const tmpDir = makeTmpDir();
  const cwd = path.join(tmpDir, 'project');
  const liveDir = path.join(tmpDir, 'epics', 'epic-1', 'prds'); // exists, stays empty
  const archivedDir = path.join(tmpDir, 'epics', 'epic-1', 'prds-archived'); // the PRD actually lives here
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(liveDir, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'ok.cjs'), 'process.exit(0);');

  const job = writePrd(archivedDir, '201-archived', '- [ ] `timeout 10 node ok.cjs` succeeds.', cwd);
  // Mirrors scheduler.cjs's own composition: live dir first, archived dir second.
  const resolvePrdPath = (j) => {
    const live = path.join(liveDir, `${j.slug}.md`);
    if (fs.existsSync(live)) return live;
    const archived = path.join(archivedDir, `${j.slug}.md`);
    return fs.existsSync(archived) ? archived : null;
  };
  try {
    const result = await reverifyAc(job, { resolvePrdPath });
    assert.strictEqual(result.status, 'pass');
  } finally {
    rmdir(tmpDir);
  }
});

// ─── reverifyAc: unverifiable — no resolver, null path, or a missing file ────

test('reverifyAc: unverifiable with reason no-prd-resolver when no resolver is given', async () => {
  const tmpDir = makeTmpDir();
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const result = await reverifyAc({ slug: '301-noresolver', cwd }, {});
    assert.strictEqual(result.status, 'unverifiable');
    assert.strictEqual(result.reason, 'no-prd-resolver');
    assert.strictEqual(result.code, null);
  } finally {
    rmdir(tmpDir);
  }
});

test('reverifyAc: unverifiable with reason prd-not-found when the resolver returns null', async () => {
  const tmpDir = makeTmpDir();
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const result = await reverifyAc({ slug: '302-nullpath', cwd }, { resolvePrdPath: () => null });
    assert.strictEqual(result.status, 'unverifiable');
    assert.strictEqual(result.reason, 'prd-not-found');
  } finally {
    rmdir(tmpDir);
  }
});

test('reverifyAc: unverifiable with reason prd-unreadable when the resolved file does not exist', async () => {
  const tmpDir = makeTmpDir();
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const result = await reverifyAc(
      { slug: '303-missing', cwd },
      { resolvePrdPath: () => path.join(tmpDir, 'nowhere', '303-missing.md') },
    );
    assert.strictEqual(result.status, 'unverifiable');
    assert.strictEqual(result.reason, 'prd-unreadable');
  } finally {
    rmdir(tmpDir);
  }
});

test('reverifyAc: unverifiable with reason cwd-missing when cwd does not exist', async () => {
  const tmpDir = makeTmpDir();
  const liveDir = path.join(tmpDir, 'prds');
  const missingCwd = path.join(tmpDir, 'nonexistent-project');

  const job = writePrd(liveDir, '304-nocwd', '- [ ] `timeout 5 node -e "process.exit(0)"` passes.', missingCwd);
  try {
    const result = await reverifyAc(job, { resolvePrdPath: resolverFor(liveDir) });
    assert.strictEqual(result.status, 'unverifiable');
    assert.strictEqual(result.reason, 'cwd-missing');
  } finally {
    rmdir(tmpDir);
  }
});

test('reverifyAc: unverifiable with reason no-parseable-gate when the PRD has no gate', async () => {
  const tmpDir = makeTmpDir();
  const cwd = path.join(tmpDir, 'project');
  const liveDir = path.join(tmpDir, 'prds');
  fs.mkdirSync(cwd, { recursive: true });

  const job = writePrd(liveDir, '305-nocmd', '- [ ] The widget renders correctly.', cwd);
  try {
    const result = await reverifyAc(job, { resolvePrdPath: resolverFor(liveDir) });
    assert.strictEqual(result.status, 'unverifiable');
    assert.strictEqual(result.reason, 'no-parseable-gate');
    assert.strictEqual(result.code, null);
  } finally {
    rmdir(tmpDir);
  }
});

// ─── reverifyAc: unverifiable — another gate already holds gateInFlight ─────

test('reverifyAc: unverifiable with reason busy while another gate is in flight', async () => {
  const tmpDir = makeTmpDir();
  const cwd = path.join(tmpDir, 'project');
  const liveDir = path.join(tmpDir, 'prds');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'slow.cjs'), 'setTimeout(() => process.exit(0), 1500);');

  const job = writePrd(liveDir, '401-busy', '- [ ] `timeout 10 node -e "process.exit(0)"` passes.', cwd);

  // Hold the module-level single-flight gate lock with a slow sequence,
  // without awaiting it. runGateSequence (exported, no new export needed)
  // sets the lock synchronously before its first internal await, so by the
  // time reverifyAc's own call reaches runGateSequence below, this one is
  // still holding it.
  const holderPromise = runGateSequence(
    [{ argv: ['node', 'slow.cjs'], timeoutMs: 10_000, env: {} }],
    { cwd },
  );
  try {
    const result = await reverifyAc(job, { resolvePrdPath: resolverFor(liveDir) });
    assert.strictEqual(result.status, 'unverifiable');
    assert.strictEqual(result.reason, 'busy');
  } finally {
    await holderPromise;
    rmdir(tmpDir);
  }
}, 10_000);

// ─── reverifyBatch: all three statuses ────────────────────────────────────────

test('reverifyBatch: returns pass/fail/unverifiable for a mixed batch', async () => {
  const tmpDir = makeTmpDir();
  const cwd = path.join(tmpDir, 'project');
  const liveDir = path.join(tmpDir, 'prds');
  fs.mkdirSync(cwd, { recursive: true });

  fs.writeFileSync(path.join(cwd, 'ok.cjs'), 'process.exit(0);');
  fs.writeFileSync(path.join(cwd, 'fail.cjs'), 'process.exit(1);');

  const jobPass = writePrd(liveDir, '201-pass', '- [ ] `timeout 10 node ok.cjs` passes.', cwd);
  const jobFail = writePrd(liveDir, '202-fail', '- [ ] `timeout 10 node fail.cjs` passes.', cwd);
  const jobNone = writePrd(liveDir, '203-noop', '- [ ] The result is correct.', cwd);

  try {
    const results = await reverifyBatch([jobPass, jobFail, jobNone], {
      batchTimeoutMs: 120_000,
      resolvePrdPath: resolverFor(liveDir),
    });
    assert.strictEqual(results.length, 3);

    const bySlug = Object.fromEntries(results.map((r) => [r.slug, r]));
    assert.strictEqual(bySlug['201-pass'].status, 'pass');
    assert.strictEqual(bySlug['202-fail'].status, 'fail');
    assert.strictEqual(bySlug['203-noop'].status, 'unverifiable');
  } finally {
    rmdir(tmpDir);
  }
});

// ─── reverifyBatch: batch wall-time cap ───────────────────────────────────────

test('reverifyBatch: marks remaining jobs unverifiable when batch cap is hit', async () => {
  const tmpDir = makeTmpDir();
  const cwd = path.join(tmpDir, 'project');
  const liveDir = path.join(tmpDir, 'prds');
  fs.mkdirSync(cwd, { recursive: true });

  // The slow job's OWN authored gate (`timeout 1`) kills it after 1s — there is
  // no longer a reverifyAc-level override to do this instead (the private 60s
  // cap this test used to lean on was removed; reverifyAc now always runs each
  // step's own declared timeout, same as the scheduler's shadow gate). By the
  // time that step is killed, batchTimeoutMs (200ms) is already spent, so the
  // loop marks the second job unverifiable without ever starting it.
  fs.writeFileSync(path.join(cwd, 'slow.cjs'), 'setTimeout(() => process.exit(0), 30_000);');
  const jobSlow = writePrd(liveDir, '501-slow', '- [ ] `timeout 1 node slow.cjs` passes.', cwd);
  fs.writeFileSync(path.join(cwd, 'ok.cjs'), 'process.exit(0);');
  const jobAfter = writePrd(liveDir, '502-after', '- [ ] `timeout 10 node ok.cjs` passes.', cwd);

  try {
    const results = await reverifyBatch([jobSlow, jobAfter], {
      batchTimeoutMs: 200,
      resolvePrdPath: resolverFor(liveDir),
    });
    assert.strictEqual(results.length, 2);
    const after = results.find((r) => r.slug === '502-after');
    assert.strictEqual(after.status, 'unverifiable');
  } finally {
    rmdir(tmpDir);
  }
}, 10_000);
