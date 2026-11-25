'use strict';

// Per-criterion cross-check in parseValidatorVerdict(value, { expected }):
// a verdict that omits a criterion id, or marks met a criterion whose
// mechanical check failed, is refused with a named error.
// Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/validatorVerdictCriteria.test.cjs

const assert = require('node:assert/strict');
const {
  VALIDATOR_VERDICT_SCHEMA,
  parseValidatorVerdict,
  expectedFromCriteria,
  formatCriteriaChecksSection,
} = require('../validatorVerdictSchema.cjs');

const entry = (prd, criteria, verdict = 'VERIFIED') => ({
  prd,
  verdict,
  reason: verdict === 'REFUTED' ? 'a criterion is unmet' : '',
  criteria,
  findings: [],
});
const run = (...verdicts) => ({ schedulerVerdict: 'PASS', verdicts });
const expected = { '3787-a': { ids: ['ac-1', 'ac-2'], failedIds: ['ac-2'] } };

describe('parseValidatorVerdict with expected criteria', () => {
  it('refuses met: true on a criterion whose mechanical check failed', () => {
    const v = run(entry('3787-a', [
      { id: 'ac-1', met: true, evidence: 'ok' },
      { id: 'ac-2', met: true, evidence: 'looked fine' },
    ]));
    const r = parseValidatorVerdict(v, { expected });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'criterion-met-on-failed-check');
    assert.match(r.error, /verdicts\[0\] \(3787-a\): criterion ac-2 marked met but its mechanical check failed/);
  });

  it('refuses a verdict that omits a criterion id', () => {
    const v = run(entry('3787-a', [{ id: 'ac-1', met: true, evidence: 'ok' }]));
    const r = parseValidatorVerdict(v, { expected });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'criterion-missing');
    assert.match(r.error, /verdicts\[0\] \(3787-a\): missing criterion id ac-2/);
  });

  it('matches an expected key by bare slug', () => {
    const v = run(entry('a', [{ id: 'ac-1', met: true, evidence: 'ok' }]));
    const r = parseValidatorVerdict(v, { expected: new Map(Object.entries(expected)) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'criterion-missing');
  });

  it('accepts every id present with the failed one unmet', () => {
    const v = run(
      entry('3787-a', [
        { id: 'ac-1', met: true, evidence: 'ok' },
        { id: 'ac-2', met: false, evidence: 'check exit 1', missKind: 'gate-red' },
      ], 'REFUTED'),
      // A PRD with no expected record is checked as before.
      entry('3788-b', [{ id: '1', met: true, evidence: 'ok' }]),
    );
    const r = parseValidatorVerdict(v, { expected });
    assert.equal(r.ok, true);
    assert.equal(r.value, v);
  });

  it('legacy call (no expected) is unchanged: the same met-on-failed verdict passes', () => {
    const v = run(entry('3787-a', [{ id: 'ac-2', met: true, evidence: 'looked fine' }]));
    assert.equal(parseValidatorVerdict(v).ok, true);
    assert.equal(parseValidatorVerdict(v, {}).ok, true);
    assert.equal(parseValidatorVerdict(v, { expected: null }).ok, true);
    // Legacy structural errors still come back without a code.
    const bad = parseValidatorVerdict({ schedulerVerdict: 'PASS' });
    assert.deepEqual(bad, { ok: false, error: 'verdict: missing verdicts' });
  });
});

describe('expectedFromCriteria', () => {
  it('collects ids and only ok: false checks as failed', () => {
    const criteria = [
      { id: 'ac-1', statement: 'x', check: { kind: 'command', spec: 'npm test' } },
      { id: 'ac-2', statement: 'y', check: { kind: 'file', spec: 'a.txt' } },
      { id: 'ac-3', statement: 'z', check: { kind: 'manual' } },
    ];
    const checks = [
      { id: 'ac-1', kind: 'command', ok: true, detail: 'exit 0' },
      { id: 'ac-2', kind: 'file', ok: false, detail: 'missing' },
      { id: 'ac-3', kind: 'manual', ok: null, detail: '' },
      { id: 'other', kind: 'file', ok: false, detail: 'stale' },
    ];
    assert.deepEqual(expectedFromCriteria(criteria, checks), { ids: ['ac-1', 'ac-2', 'ac-3'], failedIds: ['ac-2'] });
    assert.deepEqual(expectedFromCriteria(criteria, undefined), { ids: ['ac-1', 'ac-2', 'ac-3'], failedIds: [] });
    assert.equal(expectedFromCriteria(undefined, checks), null);
    assert.equal(expectedFromCriteria([], checks), null);
  });
});

describe('formatCriteriaChecksSection', () => {
  it('lists each id with its stored check result, and is empty with no criteria', () => {
    const text = formatCriteriaChecksSection([
      {
        slug: '3787-a',
        criteria: [
          { id: 'ac-1', statement: 'tests pass', check: { kind: 'command' } },
          { id: 'ac-2', statement: 'file exists', check: { kind: 'file' } },
        ],
        checks: [{ id: 'ac-2', ok: false, detail: 'not found' }],
      },
      { slug: '3788-b', criteria: undefined, checks: [] },
    ]);
    assert.match(text, /Stored mechanical check results/);
    assert.match(text, /### 3787-a/);
    assert.match(text, /`ac-1` \(command\) not run: tests pass/);
    assert.match(text, /`ac-2` \(file\) FAIL — not found: file exists/);
    assert.doesNotMatch(text, /3788-b/);
    assert.equal(formatCriteriaChecksSection([{ slug: 'x', criteria: [], checks: [] }]), '');
  });
});

describe('schema', () => {
  it('criteria items stay { id, met, evidence } required', () => {
    const items = VALIDATOR_VERDICT_SCHEMA.properties.verdicts.items;
    assert.ok(items.required.includes('criteria'));
    assert.deepEqual(items.properties.criteria.items.required, ['id', 'met', 'evidence']);
    assert.match(items.properties.criteria.items.properties.id.description, /one entry per criterion id/i);
  });
});

describe('scheduler loadValidatorCriteriaContext', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  let tmpHome;
  let originalHome;
  let loadValidatorCriteriaContext;

  beforeAll(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-validator-criteria-'));
    process.env.HOME = tmpHome;
    ({ loadValidatorCriteriaContext } = require('../../../scheduler.cjs'));
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('builds expected { ids, failedIds } from PRD frontmatter criteria + the stored outcome checks', async () => {
    const cwd = fs.mkdtempSync(path.join(tmpHome, 'proj-'));
    const epicId = 'epic-abc';
    const epicDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epicId);
    fs.mkdirSync(path.join(epicDir, 'prds'), { recursive: true });
    fs.mkdirSync(path.join(epicDir, 'outcomes'), { recursive: true });
    const criteria = [
      { id: 'ac-1', statement: 'tests pass', check: { kind: 'command', spec: 'npm test' } },
      { id: 'ac-2', statement: 'file exists', check: { kind: 'file', spec: 'a.txt' } },
    ];
    fs.writeFileSync(
      path.join(epicDir, 'prds', '3787-a.md'),
      `---\ntitle: A\ncriteria: ${JSON.stringify(criteria)}\n---\n# Goal\n\nx\n`,
    );
    fs.writeFileSync(path.join(epicDir, 'prds', '3788-b.md'), '---\ntitle: B\n---\n# Goal\n\ny\n');
    fs.writeFileSync(
      path.join(epicDir, 'outcomes', '3787-a.json'),
      JSON.stringify({ slug: '3787-a', checks: [{ id: 'ac-1', ok: true, detail: 'exit 0' }, { id: 'ac-2', ok: false, detail: 'missing' }] }),
    );
    const ctx = await loadValidatorCriteriaContext({ agentType: 'validator', cwd, epicId, slug: '3790-validate', dependsOn: ['3787-a', '3788-b'] });
    assert.deepEqual(ctx.expected, { '3787-a': { ids: ['ac-1', 'ac-2'], failedIds: ['ac-2'] } });
    // file criteria run fresh at dispatch: a.txt is absent in cwd → FAIL, stamped.
    assert.match(ctx.section, /`ac-2` \(file\) FAIL \(ran [^)]+\) — missing: a\.txt: file exists/);
    assert.match(ctx.section, /`ac-1` \(command\) PASS — exit 0: tests pass/);
    const rec = JSON.parse(fs.readFileSync(path.join(epicDir, 'outcomes', '3787-a.json'), 'utf8'));
    assert.equal(rec.checks.find((c) => c.id === 'ac-1').detail, 'exit 0');
    assert.equal(rec.checks.find((c) => c.id === 'ac-2').stage, 'validator-dispatch');
    assert.doesNotMatch(ctx.section, /3788-b/);

    const nonValidator = await loadValidatorCriteriaContext({ agentType: 'dev-lead', cwd, epicId, dependsOn: ['3787-a'] });
    assert.deepEqual(nonValidator, { expected: {}, section: '' });
  });

  describe('loopback http criteria with the OS sandbox available (socat present)', () => {
    const http = require('node:http');
    const { buildJobSandboxSettings } = require('../../claude/jobSandboxPolicy.cjs');
    const { loadEnvironment } = require('../../claude/environmentProfiles.cjs');
    let server;
    let base;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ items: [{ name: 'a' }, { name: 'b' }] })); return; }
        res.writeHead(500); res.end('boom');
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

    it('validator-readonly is os-sandbox with no network, so the scheduler runs loopback checks at dispatch', async () => {
      const env = loadEnvironment({ name: 'validator-readonly', homeDir: tmpHome });
      const policy = buildJobSandboxSettings({
        agentType: 'validator', environment: env, worktreeDir: tmpHome, projectRoot: tmpHome,
        homeDir: tmpHome, tmpDir: os.tmpdir(), deps: { available: true, missing: [] }, mode: 'enforce',
      });
      assert.equal(policy.level, 'os-sandbox');
      assert.deepEqual(policy.settings.sandbox.network.allowedDomains, []);

      const cwd = fs.mkdtempSync(path.join(tmpHome, 'proj-'));
      const epicId = 'epic-loop';
      const epicDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epicId);
      fs.mkdirSync(path.join(epicDir, 'prds'), { recursive: true });
      fs.mkdirSync(path.join(epicDir, 'outcomes'), { recursive: true });
      const criteria = [
        { id: 'live-ok', statement: 'route answers', check: { kind: 'http', spec: { url: `${base}/ok` } } },
        { id: 'live-bad', statement: 'broken route answers', check: { kind: 'http', spec: { url: `${base}/bad` } } },
        { id: 'gate', statement: 'tests pass', check: { kind: 'command', spec: 'npm test' } },
      ];
      fs.writeFileSync(path.join(epicDir, 'prds', '4459-live.md'), `---\ntitle: L\ncriteria: ${JSON.stringify(criteria)}\n---\n# Goal\n\nx\n`);
      fs.writeFileSync(path.join(epicDir, 'outcomes', '4459-live.json'), JSON.stringify({
        slug: '4459-live', verdict: 'completed', checks: [{ id: 'gate', kind: 'command', ok: true, detail: 'exit 0' }, { id: 'live-bad', kind: 'http', ok: null, detail: 'old' }],
      }));

      const ctx = await loadValidatorCriteriaContext({ agentType: 'validator', cwd, epicId, slug: '4460-validate', dependsOn: ['4459-live'] }, { httpRetry: { delayMs: 5 } });
      assert.match(ctx.section, /`live-ok` \(http\) PASS \(ran [^)]+\) — HTTP 200/);
      assert.match(ctx.section, /`live-bad` \(http\) FAIL \(ran [^)]+\) \(3 attempts\) — HTTP 500, expected 200/);
      assert.match(ctx.section, /`gate` \(command\) PASS — exit 0/);
      assert.match(ctx.section, /run by the scheduler outside your sandbox just before you started/);
      assert.match(ctx.section, /cannot reach host loopback/);
      assert.deepEqual(ctx.expected['4459-live'], { ids: ['live-ok', 'live-bad', 'gate'], failedIds: ['live-bad'] });

      // body sidecar: written to <slug>.bodies/<id>.txt, path in the section, never inline in the record.
      const bodyFile = path.join(epicDir, 'outcomes', '4459-live.bodies', 'live-ok.txt');
      assert.deepEqual(JSON.parse(fs.readFileSync(bodyFile, 'utf8')), { items: [{ name: 'a' }, { name: 'b' }] });
      const okBytes = fs.statSync(bodyFile).size;
      assert.ok(ctx.section.includes(`body: ${bodyFile} (${okBytes} bytes)`));

      const rec = JSON.parse(fs.readFileSync(path.join(epicDir, 'outcomes', '4459-live.json'), 'utf8'));
      const byId = Object.fromEntries(rec.checks.map((c) => [c.id, c]));
      assert.equal(byId.gate.detail, 'exit 0');
      assert.equal(byId['live-ok'].ok, true);
      assert.equal(byId['live-ok'].bodyPath, bodyFile);
      assert.equal(byId['live-ok'].bodyBytes, okBytes);
      assert.equal(byId['live-ok'].truncated, false);
      assert.equal('body' in byId['live-ok'], false);
      assert.equal(byId['live-bad'].ok, false);
      assert.equal(byId['live-bad'].stage, 'validator-dispatch');
      assert.equal(rec.verdict, 'completed');

      const verdict = (met) => ({ schedulerVerdict: 'PASS', verdicts: [{
        prd: '4459-live', verdict: met ? 'VERIFIED' : 'REFUTED', reason: met ? '' : 'route 500s', findings: [],
        criteria: [
          { id: 'live-ok', met: true, evidence: 'PASS' },
          { id: 'live-bad', met, evidence: 'FAIL HTTP 500', ...(met ? {} : { missKind: 'behavior-wrong' }) },
          { id: 'gate', met: true, evidence: 're-ran' },
        ],
      }] });
      const refused = parseValidatorVerdict(verdict(true), { expected: ctx.expected });
      assert.equal(refused.ok, false);
      assert.equal(refused.code, 'criterion-met-on-failed-check');
      const accepted = parseValidatorVerdict(verdict(false), { expected: ctx.expected });
      assert.equal(accepted.ok, true, accepted.error);
    });

    it('runChecks: false makes no request, leaves the outcome record byte-identical, and builds expected from stored checks', async () => {
      let requests = 0;
      const counted = http.createServer((req, res) => { requests += 1; res.writeHead(200); res.end('ok'); });
      await new Promise((resolve) => counted.listen(0, '127.0.0.1', resolve));
      try {
        const url = `http://127.0.0.1:${counted.address().port}/ok`;
        const cwd = fs.mkdtempSync(path.join(tmpHome, 'proj-'));
        const epicId = 'epic-norun';
        const epicDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epicId);
        fs.mkdirSync(path.join(epicDir, 'prds'), { recursive: true });
        fs.mkdirSync(path.join(epicDir, 'outcomes'), { recursive: true });
        const criteria = [
          { id: 'live', statement: 'route answers', check: { kind: 'http', spec: { url } } },
          { id: 'gate', statement: 'tests pass', check: { kind: 'command', spec: 'npm test' } },
        ];
        fs.writeFileSync(path.join(epicDir, 'prds', '4470-norun.md'), `---\ntitle: N\ncriteria: ${JSON.stringify(criteria)}\n---\n# Goal\n\nx\n`);
        const recPath = path.join(epicDir, 'outcomes', '4470-norun.json');
        fs.writeFileSync(recPath, JSON.stringify({
          slug: '4470-norun', verdict: 'completed', checks: [{ id: 'gate', kind: 'command', ok: true, detail: 'exit 0' }, { id: 'live', kind: 'http', ok: false, detail: 'HTTP 500' }],
        }));
        const before = fs.readFileSync(recPath);
        const ctx = await loadValidatorCriteriaContext({ agentType: 'validator', cwd, epicId, slug: '4471-validate', dependsOn: ['4470-norun'] }, { runChecks: false });
        assert.equal(requests, 0);
        assert.ok(fs.readFileSync(recPath).equals(before));
        assert.equal(fs.existsSync(path.join(epicDir, 'outcomes', '4470-norun.bodies')), false);
        assert.deepEqual(ctx.expected['4470-norun'], { ids: ['live', 'gate'], failedIds: ['live'] });
      } finally {
        await new Promise((resolve) => counted.close(resolve));
      }
    });

    /** @param {string} epicId @param {string} slug @param {unknown[]} criteria */
    const fixture = (epicId, slug, criteria) => {
      const cwd = fs.mkdtempSync(path.join(tmpHome, 'proj-'));
      const epicDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epicId);
      fs.mkdirSync(path.join(epicDir, 'prds'), { recursive: true });
      fs.mkdirSync(path.join(epicDir, 'outcomes'), { recursive: true });
      fs.writeFileSync(path.join(epicDir, 'prds', `${slug}.md`), `---\ntitle: R\ncriteria: ${JSON.stringify(criteria)}\n---\n# Goal\n\nx\n`);
      fs.writeFileSync(path.join(epicDir, 'outcomes', `${slug}.json`), JSON.stringify({ slug, verdict: 'completed', checks: [] }));
      return { cwd, recPath: path.join(epicDir, 'outcomes', `${slug}.json`) };
    };

    it('retries an http check that 503s once while the server reloads → PASS (2 attempts)', async () => {
      let hits = 0;
      const flaky = http.createServer((req, res) => { hits += 1; if (hits === 1) { res.writeHead(503); res.end('reloading'); return; } res.writeHead(200); res.end('ok'); });
      await new Promise((resolve) => flaky.listen(0, '127.0.0.1', resolve));
      try {
        const url = `http://127.0.0.1:${flaky.address().port}/ok`;
        const epicId = 'epic-retry';
        const { cwd, recPath } = fixture(epicId, '4546-flaky', [{ id: 'live', statement: 'route answers', check: { kind: 'http', spec: { url } } }]);
        const ctx = await loadValidatorCriteriaContext({ agentType: 'validator', cwd, epicId, slug: '4547-validate', dependsOn: ['4546-flaky'] }, { httpRetry: { delayMs: 5 } });
        assert.equal(hits, 2);
        assert.deepEqual(ctx.expected['4546-flaky'], { ids: ['live'], failedIds: [] });
        const row = JSON.parse(fs.readFileSync(recPath, 'utf8')).checks.find((c) => c.id === 'live');
        assert.equal(row.ok, true);
        assert.equal(row.attempts, 2);
        const line = ctx.section.split('\n').find((l) => l.includes('`live`'));
        assert.match(line, /PASS/);
        assert.ok(line.includes('(2 attempts)'), line);
        assert.match(ctx.section, /retried \(up to 3 attempts, 10 s apart\)/);
      } finally {
        await new Promise((resolve) => flaky.close(resolve));
      }
    });

    it('an always-404 http check is still a FAIL after 3 attempts', async () => {
      let hits = 0;
      const gone = http.createServer((req, res) => { hits += 1; res.writeHead(404); res.end('nope'); });
      await new Promise((resolve) => gone.listen(0, '127.0.0.1', resolve));
      try {
        const url = `http://127.0.0.1:${gone.address().port}/missing`;
        const epicId = 'epic-retry404';
        const { cwd, recPath } = fixture(epicId, '4546-gone', [{ id: 'live', statement: 'route answers', check: { kind: 'http', spec: { url } } }]);
        const ctx = await loadValidatorCriteriaContext({ agentType: 'validator', cwd, epicId, slug: '4547-validate', dependsOn: ['4546-gone'] }, { httpRetry: { delayMs: 5 } });
        assert.equal(hits, 3);
        assert.deepEqual(ctx.expected['4546-gone'], { ids: ['live'], failedIds: ['live'] });
        const row = JSON.parse(fs.readFileSync(recPath, 'utf8')).checks.find((c) => c.id === 'live');
        assert.equal(row.ok, false);
        assert.equal(row.attempts, 3);
        const line = ctx.section.split('\n').find((l) => l.includes('`live`'));
        assert.match(line, /FAIL/);
        assert.ok(line.includes('(3 attempts)'), line);
      } finally {
        await new Promise((resolve) => gone.close(resolve));
      }
    });

    it('forwards an injected httpRetry.sleep: an always-404 check counts two 10 s waits without real waiting', async () => {
      const gone = http.createServer((req, res) => { res.writeHead(404); res.end('nope'); });
      await new Promise((resolve) => gone.listen(0, '127.0.0.1', resolve));
      try {
        const url = `http://127.0.0.1:${gone.address().port}/missing`;
        const epicId = 'epic-sleep404';
        const { cwd, recPath } = fixture(epicId, '4559-gone', [{ id: 'live', statement: 'route answers', check: { kind: 'http', spec: { url } } }]);
        /** @type {number[]} */
        const calls = [];
        const sleep = async (/** @type {number} */ ms) => { calls.push(ms); };
        const t0 = Date.now();
        await loadValidatorCriteriaContext({ agentType: 'validator', cwd, epicId, slug: '4560-validate', dependsOn: ['4559-gone'] }, { httpRetry: { delayMs: 10000, sleep } });
        assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
        assert.deepEqual(calls, [10000, 10000]);
        const row = JSON.parse(fs.readFileSync(recPath, 'utf8')).checks.find((c) => c.id === 'live');
        assert.equal(row.ok, false);
        assert.equal(row.attempts, 3);
      } finally {
        await new Promise((resolve) => gone.close(resolve));
      }
    });

    it('an injected httpRetry.sleep is never called when the http check passes first time', async () => {
      const ok = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
      await new Promise((resolve) => ok.listen(0, '127.0.0.1', resolve));
      try {
        const url = `http://127.0.0.1:${ok.address().port}/ok`;
        const epicId = 'epic-sleep200';
        const { cwd, recPath } = fixture(epicId, '4559-ok', [{ id: 'live', statement: 'route answers', check: { kind: 'http', spec: { url } } }]);
        /** @type {number[]} */
        const calls = [];
        const sleep = async (/** @type {number} */ ms) => { calls.push(ms); };
        await loadValidatorCriteriaContext({ agentType: 'validator', cwd, epicId, slug: '4560-validate', dependsOn: ['4559-ok'] }, { httpRetry: { delayMs: 10000, sleep } });
        assert.deepEqual(calls, []);
        const row = JSON.parse(fs.readFileSync(recPath, 'utf8')).checks.find((c) => c.id === 'live');
        assert.equal(row.ok, true);
        assert.equal(row.attempts, 1);
      } finally {
        await new Promise((resolve) => ok.close(resolve));
      }
    });
  });
});

describe('formatCriteriaChecksSection attempts suffix', () => {
  const criteria = [
    { id: 'one', statement: 's1', check: { kind: 'http', spec: { url: 'http://127.0.0.1:1/' } } },
    { id: 'none', statement: 's2', check: { kind: 'file', spec: 'a.txt' } },
    { id: 'three', statement: 's3', check: { kind: 'http', spec: { url: 'http://127.0.0.1:1/' } } },
  ];
  const checks = [
    { id: 'one', ok: true, detail: 'HTTP 200', ranAt: '2026-11-24T00:00:00.000Z', attempts: 1 },
    { id: 'none', ok: true, detail: 'exists', ranAt: '2026-11-24T00:00:00.000Z' },
    { id: 'three', ok: false, detail: 'HTTP 404, expected 200', ranAt: '2026-11-24T00:00:00.000Z', attempts: 3 },
  ];
  const section = formatCriteriaChecksSection([{ slug: '4546-x', criteria, checks }]);
  const line = (id) => section.split('\n').find((l) => l.includes(`\`${id}\``));

  it('prints no suffix for attempts 1 or absent', () => {
    assert.doesNotMatch(line('one'), /attempts?\)/);
    assert.doesNotMatch(line('none'), /attempts?\)/);
  });

  it('prints (N attempts) right after the ranAt part when N > 1', () => {
    assert.ok(line('three').includes('FAIL (ran 2026-11-24T00:00:00.000Z) (3 attempts) — HTTP 404'), line('three'));
  });
});
