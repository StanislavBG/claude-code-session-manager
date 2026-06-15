/**
 * dod-report.test.cjs — unit tests for flagRiskySurfaces + writeReport.
 *
 * Run: timeout 120 node --test src/main/__tests__/dod-report.test.cjs
 *
 * Fixtures: os.tmpdir() only — never writes into real runs/.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { flagRiskySurfaces, writeReport } = require('../lib/definitionOfDone.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dod-report-test-'));
}

function rmdir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

function writePrd(prdsDir, slug, implNotes, cwd) {
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
    '- [ ] `timeout 10 node -e "process.exit(0)"` passes.',
    '',
    '# Implementation notes',
    '',
    implNotes,
    '',
    '# Out of scope',
    '',
    '- N/A',
  ].join('\n');
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), body);
  return { slug, cwd };
}

// ─── flagRiskySurfaces: money-path ────────────────────────────────────────────

test('flagRiskySurfaces: flags money-path when impl notes reference payment', () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);
  const job = writePrd(prdsDir, '201-billing', '- Edit `src/payment-processor.js`\n- Update order schema', cwd);
  try {
    const flags = flagRiskySurfaces([job], { prdsDir });
    assert.strictEqual(flags.length, 1);
    assert.strictEqual(flags[0].slug, '201-billing');
    assert.ok(flags[0].surfaces.includes('money-path'), `expected money-path in ${JSON.stringify(flags[0].surfaces)}`);
  } finally {
    rmdir(tmpDir);
  }
});

test('flagRiskySurfaces: flags auth when impl notes reference auth/token', () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);
  const job = writePrd(prdsDir, '202-auth', '- Modify `src/auth-middleware.py`\n- Update token refresh logic', cwd);
  try {
    const flags = flagRiskySurfaces([job], { prdsDir });
    assert.strictEqual(flags.length, 1);
    assert.ok(flags[0].surfaces.includes('auth'));
  } finally {
    rmdir(tmpDir);
  }
});

test('flagRiskySurfaces: flags migration when impl notes reference .sql file', () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);
  const job = writePrd(prdsDir, '203-schema', '- Run `db/migrations/0042_users.sql`', cwd);
  try {
    const flags = flagRiskySurfaces([job], { prdsDir });
    assert.strictEqual(flags.length, 1);
    assert.ok(flags[0].surfaces.includes('migration'));
  } finally {
    rmdir(tmpDir);
  }
});

test('flagRiskySurfaces: clean job is not returned', () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);
  const job = writePrd(prdsDir, '204-clean', '- Update `src/ui/button.tsx`\n- Add tooltip component', cwd);
  try {
    const flags = flagRiskySurfaces([job], { prdsDir });
    assert.strictEqual(flags.length, 0);
  } finally {
    rmdir(tmpDir);
  }
});

test('flagRiskySurfaces: job with no PRD file is skipped (not thrown)', () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);
  try {
    const flags = flagRiskySurfaces([{ slug: '205-missing', cwd }], { prdsDir });
    assert.strictEqual(flags.length, 0);
  } finally {
    rmdir(tmpDir);
  }
});

test('flagRiskySurfaces: mixed batch returns only risky jobs', () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);
  const jobRisky = writePrd(prdsDir, '206-risky', '- Modify `src/trade-engine.js`', cwd);
  const jobClean = writePrd(prdsDir, '207-clean', '- Update `src/tooltip.tsx`', cwd);
  try {
    const flags = flagRiskySurfaces([jobRisky, jobClean], { prdsDir });
    assert.strictEqual(flags.length, 1);
    assert.strictEqual(flags[0].slug, '206-risky');
  } finally {
    rmdir(tmpDir);
  }
});

// ─── writeReport: structure ────────────────────────────────────────────────────

test('writeReport: all three jobs appear in AC table', () => {
  const tmpDir = makeTmpDir();
  const runsDir = path.join(tmpDir, 'runs');
  const acResults = [
    { slug: '101-pass',  status: 'pass',         code: 0,    ms: 500 },
    { slug: '102-fail',  status: 'fail',         code: 1,    ms: 300 },
    { slug: '103-risky', status: 'pass',         code: 0,    ms: 400 },
  ];
  const riskFlags = [{ slug: '103-risky', surfaces: ['money-path'] }];
  try {
    const reportPath = writeReport('abcd1234', { acResults, riskFlags, runsDir });
    assert.ok(fs.existsSync(reportPath), `report missing at ${reportPath}`);
    const content = fs.readFileSync(reportPath, 'utf8');
    assert.ok(content.includes('101-pass'), 'missing 101-pass in table');
    assert.ok(content.includes('102-fail'), 'missing 102-fail in table');
    assert.ok(content.includes('103-risky'), 'missing 103-risky in table');
  } finally {
    rmdir(tmpDir);
  }
});

test('writeReport: fail and risky slug both appear in needs-attention list', () => {
  const tmpDir = makeTmpDir();
  const runsDir = path.join(tmpDir, 'runs');
  const acResults = [
    { slug: '101-pass',  status: 'pass', code: 0, ms: 500 },
    { slug: '102-fail',  status: 'fail', code: 1, ms: 300 },
    { slug: '103-risky', status: 'pass', code: 0, ms: 400 },
  ];
  const riskFlags = [{ slug: '103-risky', surfaces: ['money-path'] }];
  try {
    const reportPath = writeReport('abcd1234', { acResults, riskFlags, runsDir });
    const content = fs.readFileSync(reportPath, 'utf8');
    // Both should appear in the Needs Human Attention section
    const attentionIdx = content.indexOf('## Needs Human Attention');
    assert.ok(attentionIdx !== -1, 'missing Needs Human Attention section');
    const attentionSection = content.slice(attentionIdx);
    assert.ok(attentionSection.includes('102-fail'), '102-fail missing from attention list');
    assert.ok(attentionSection.includes('103-risky'), '103-risky missing from attention list');
    // Clean pass should NOT be in attention list
    const passInAttention = attentionSection.includes('101-pass');
    assert.ok(!passInAttention, '101-pass should not appear in attention list');
  } finally {
    rmdir(tmpDir);
  }
});

test('writeReport: report states review is recommended, not auto-run', () => {
  const tmpDir = makeTmpDir();
  const runsDir = path.join(tmpDir, 'runs');
  try {
    const reportPath = writeReport('abcd1234', { acResults: [], riskFlags: [], runsDir });
    const content = fs.readFileSync(reportPath, 'utf8');
    assert.ok(
      content.toLowerCase().includes('recommended') && content.toLowerCase().includes('not auto-run'),
      'report must state review is recommended, not auto-run'
    );
  } finally {
    rmdir(tmpDir);
  }
});

test('writeReport: no .tmp files left after write', () => {
  const tmpDir = makeTmpDir();
  const runsDir = path.join(tmpDir, 'runs');
  const acResults = [{ slug: '101-pass', status: 'pass', code: 0, ms: 100 }];
  try {
    writeReport('deadbeef', { acResults, riskFlags: [], runsDir });
    // Walk all files in runsDir recursively, check none end in .tmp-*
    function findTmps(dir) {
      const hits = [];
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) hits.push(...findTmps(full));
          else if (e.name.includes('.tmp-')) hits.push(full);
        }
      } catch { /* */ }
      return hits;
    }
    const tmps = findTmps(runsDir);
    assert.deepStrictEqual(tmps, [], `found leftover tmp files: ${tmps.join(', ')}`);
  } finally {
    rmdir(tmpDir);
  }
});

test('writeReport: second call with same batchKey produces clean report, no tmp files', () => {
  const tmpDir = makeTmpDir();
  const runsDir = path.join(tmpDir, 'runs');
  const acResults = [
    { slug: '101-pass', status: 'pass', code: 0, ms: 100 },
    { slug: '102-fail', status: 'fail', code: 1, ms: 200 },
  ];
  const riskFlags = [{ slug: '101-pass', surfaces: ['auth'] }];
  try {
    writeReport('cafebabe', { acResults, riskFlags, runsDir });
    // Small delay to guarantee different timestamp dir
    const t = Date.now() + 2;
    while (Date.now() < t) { /* busy wait 2ms */ }
    const report2 = writeReport('cafebabe', { acResults, riskFlags, runsDir });

    // Second report must exist and be valid
    assert.ok(fs.existsSync(report2));
    const content = fs.readFileSync(report2, 'utf8');

    // No duplicate rows in the AC table — slice only the AC table section.
    const acStart = content.indexOf('## AC Results');
    const riskStart = content.indexOf('## Risk Flags');
    const acSection = content.slice(acStart, riskStart === -1 ? undefined : riskStart);
    const passCount = (acSection.match(/101-pass/g) || []).length;
    const failCount = (acSection.match(/102-fail/g) || []).length;
    assert.strictEqual(passCount, 1, `101-pass appears ${passCount} times in AC table`);
    assert.strictEqual(failCount, 1, `102-fail appears ${failCount} times in AC table`);

    // No tmp files anywhere
    function findTmps(dir) {
      const hits = [];
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) hits.push(...findTmps(full));
          else if (e.name.includes('.tmp-')) hits.push(full);
        }
      } catch { /* */ }
      return hits;
    }
    assert.deepStrictEqual(findTmps(runsDir), []);
  } finally {
    rmdir(tmpDir);
  }
});

test('writeReport: report filename contains the batchKey', () => {
  const tmpDir = makeTmpDir();
  const runsDir = path.join(tmpDir, 'runs');
  try {
    const reportPath = writeReport('feed1234', { acResults: [], riskFlags: [], runsDir });
    assert.ok(path.basename(reportPath).includes('feed1234'));
  } finally {
    rmdir(tmpDir);
  }
});

test('writeReport: invalid batchKey throws', () => {
  assert.throws(
    () => writeReport('not-hex!!', { acResults: [], riskFlags: [] }),
    /invalid batchKey/
  );
});
