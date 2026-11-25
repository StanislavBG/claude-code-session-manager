'use strict';
import { test, expect, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {
  runCriteriaChecks,
  COMMAND_CAP_MS,
  HTTP_TIMEOUT_MS,
} = require('../criteriaChecks.cjs');

function mkcwd() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'criteria-checks-test-'));
  fs.writeFileSync(path.join(d, 'present.txt'), 'hello criteria world\n');
  return d;
}
const crit = (id, kind, spec) => ({ id, statement: `${id} statement`, check: spec === undefined ? { kind } : { kind, spec } });

const servers = [];
function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    servers.push(srv);
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}
afterAll(() => { for (const s of servers) s.close(); });

test('caps match the PRD contract', () => {
  expect(COMMAND_CAP_MS).toBe(300_000);
  expect(HTTP_TIMEOUT_MS).toBe(15_000);
});

test('command check passes and fails through the gate runner (no shell)', async () => {
  const cwd = mkcwd();
  const results = await runCriteriaChecks({
    cwd,
    criteria: [
      crit('cmd-pass', 'command', "timeout 30 node -e 'process.exit(0)'"),
      crit('cmd-fail', 'command', "timeout 30 node -e 'process.exit(3)'"),
      // A shell metachar is refused — never handed to a shell.
      crit('cmd-shell', 'command', 'echo hi | cat'),
    ],
  });
  expect(results.map((r) => [r.id, r.kind, r.ok])).toEqual([
    ['cmd-pass', 'command', true],
    ['cmd-fail', 'command', false],
    ['cmd-shell', 'command', false],
  ]);
  expect(results[1].detail).toMatch(/exit 3/);
  expect(results[2].detail).toMatch(/shell/i);
});

test('command check times out at the cap', async () => {
  const cwd = mkcwd();
  const [r] = await runCriteriaChecks({
    cwd,
    commandCapMs: 500,
    criteria: [crit('cmd-slow', 'command', "timeout 60 node -e 'setTimeout(()=>{},30000)'")],
  });
  expect(r.ok).toBe(false);
  expect(r.detail).toMatch(/timed out/);
});

test('file check: existence and contains, passing and failing, and no escape', async () => {
  const cwd = mkcwd();
  const results = await runCriteriaChecks({
    cwd,
    criteria: [
      crit('f-exists', 'file', 'present.txt'),
      crit('f-missing', 'file', 'absent.txt'),
      crit('f-contains', 'file', { path: 'present.txt', contains: 'criteria world' }),
      crit('f-not-contains', 'file', { path: 'present.txt', contains: 'nope' }),
      crit('f-escape', 'file', '../outside.txt'),
    ],
  });
  expect(results.map((r) => r.ok)).toEqual([true, false, true, false, false]);
  expect(results[4].detail).toMatch(/repo-relative/);
});

test('http check: loopback pass and status mismatch fail', async () => {
  const port = await listen((req, res) => {
    res.statusCode = req.url === '/ok' ? 200 : 404;
    res.end('x');
  });
  const results = await runCriteriaChecks({
    cwd: mkcwd(),
    criteria: [
      crit('h-ok', 'http', `http://127.0.0.1:${port}/ok`),
      crit('h-404', 'http', { url: `http://localhost:${port}/missing`, status: 200 }),
      crit('h-404-expected', 'http', { url: `http://127.0.0.1:${port}/missing`, status: 404 }),
    ],
  });
  expect(results.map((r) => r.ok)).toEqual([true, false, true]);
  expect(results[1].detail).toMatch(/404/);
});

test('http check contains: body match, mismatch, and a body over 1 MiB without the text fails', async () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 'a');
  const port = await listen((req, res) => {
    if (req.url === '/big') { res.statusCode = 200; res.end(big); return; }
    if (req.url === '/bigtail') { res.statusCode = 200; res.end(Buffer.concat([big, Buffer.from('NEEDLE')])); return; }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ runbook: 'steps here' }));
  });
  const results = await runCriteriaChecks({
    cwd: mkcwd(),
    criteria: [
      crit('c-match', 'http', { url: `http://127.0.0.1:${port}/j`, contains: '"runbook":"steps' }),
      crit('c-miss', 'http', { url: `http://127.0.0.1:${port}/j`, contains: 'nope' }),
      crit('c-big', 'http', { url: `http://127.0.0.1:${port}/big`, contains: 'NEEDLE' }),
      crit('c-bigtail', 'http', { url: `http://127.0.0.1:${port}/bigtail`, contains: 'NEEDLE' }),
      crit('c-status', 'http', { url: `http://127.0.0.1:${port}/j`, status: 404, contains: 'runbook' }),
    ],
  });
  expect(results.map((r) => r.ok)).toEqual([true, false, false, false, false]);
  expect(results[0].detail).toBe('HTTP 200, body contains the text');
  expect(results[1].detail).toBe('HTTP 200, body does not contain "nope"');
  expect(results[2].detail).toBe('HTTP 200, body does not contain "NEEDLE"');
  expect(results[4].detail).toMatch(/HTTP 200, expected 404/);
  for (const r of results) expect(Object.keys(r).sort()).toEqual(['detail', 'id', 'kind', 'ok']);
});

test('keepBody: http rows carry body, bodyBytes and truncated only when asked', async () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 'b');
  const port = await listen((req, res) => {
    res.statusCode = 200;
    res.end(req.url === '/big' ? big : '{"ok":true}');
  });
  const criteria = [
    crit('k-small', 'http', `http://127.0.0.1:${port}/small`),
    crit('k-big', 'http', { url: `http://127.0.0.1:${port}/big`, contains: 'b' }),
    crit('k-file', 'file', 'present.txt'),
  ];
  const kept = await runCriteriaChecks({ cwd: mkcwd(), criteria, keepBody: true });
  expect(kept[0]).toMatchObject({ ok: true, body: '{"ok":true}', bodyBytes: 11, truncated: false });
  expect(kept[1].ok).toBe(true);
  expect(kept[1].truncated).toBe(true);
  expect(kept[1].bodyBytes).toBe(1048576);
  expect(kept[1].body).toHaveLength(1048576);
  expect('body' in kept[2]).toBe(false);
  const plain = await runCriteriaChecks({ cwd: mkcwd(), criteria });
  for (const r of plain) expect(Object.keys(r).sort()).toEqual(['detail', 'id', 'kind', 'ok']);
});

test('http check refuses a non-loopback host without connecting', async () => {
  const [r] = await runCriteriaChecks({
    cwd: mkcwd(),
    criteria: [crit('h-remote', 'http', 'https://example.com/')],
  });
  expect(r.ok).toBe(false);
  expect(r.detail).toMatch(/loopback/);
});

test('http check times out', async () => {
  const port = await listen(() => { /* never answers */ });
  const [r] = await runCriteriaChecks({
    cwd: mkcwd(),
    httpTimeoutMs: 300,
    criteria: [crit('h-hang', 'http', `http://127.0.0.1:${port}/`)],
  });
  expect(r.ok).toBe(false);
  expect(r.detail).toMatch(/timed out/);
});

test('manual checks return ok: null; plain-string criteria are manual', async () => {
  const results = await runCriteriaChecks({
    cwd: mkcwd(),
    criteria: [crit('m-1', 'manual', 'look at it'), crit('m-2', 'manual')],
  });
  expect(results).toEqual([
    { id: 'm-1', kind: 'manual', ok: null, detail: 'look at it' },
    { id: 'm-2', kind: 'manual', ok: null, detail: 'manual check' },
  ]);
});

test('empty or missing criteria yields []; unknown kind fails closed', async () => {
  expect(await runCriteriaChecks({ cwd: mkcwd(), criteria: [] })).toEqual([]);
  expect(await runCriteriaChecks({ cwd: mkcwd(), criteria: undefined })).toEqual([]);
  const [r] = await runCriteriaChecks({ cwd: mkcwd(), criteria: [crit('x', 'weird', 'a')] });
  expect(r.ok).toBe(false);
});

test('reverifyAc runs frontmatter criteria after the gate and keeps the results; writeReport renders them', async () => {
  const { reverifyAc, writeReport } = require('../definitionOfDone.cjs');
  const cwd = mkcwd();
  const criteria = [
    crit('ac-file', 'file', 'present.txt'),
    crit('ac-cmd', 'command', "timeout 30 node -e 'process.exit(1)'"),
    crit('ac-manual', 'manual'),
  ];
  const prd = [
    '---',
    'title: t',
    `criteria: ${JSON.stringify(criteria)}`,
    '---',
    '# Goal',
    '',
    'x',
    '',
    '# Gate',
    '',
    '```gate',
    "timeout 30 node -e 'process.exit(0)'",
    '```',
    '',
  ].join('\n');
  const prdPath = path.join(cwd, 'prd.md');
  fs.writeFileSync(prdPath, prd);
  const r = await reverifyAc({ slug: 's1', cwd }, { resolvePrdPath: () => prdPath });
  expect(r.status).toBe('pass');
  expect(r.criteriaChecks.map((c) => [c.id, c.ok])).toEqual([['ac-file', true], ['ac-cmd', false], ['ac-manual', null]]);

  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'criteria-report-'));
  const reportPath = writeReport('abc123', { acResults: [r], runsDir });
  const text = fs.readFileSync(reportPath, 'utf8');
  expect(text).toMatch(/## Criteria Checks/);
  expect(text).toMatch(/\| s1 \| ac-cmd \| command \| ❌ fail \|/);
  expect(text).toMatch(/criteria check failed: ac-cmd/);
});

test('reverifyAc without criteria carries no criteriaChecks key', async () => {
  const { reverifyAc } = require('../definitionOfDone.cjs');
  const cwd = mkcwd();
  const prdPath = path.join(cwd, 'prd.md');
  fs.writeFileSync(prdPath, "---\ntitle: t\n---\n# Gate\n\n```gate\ntimeout 30 node -e 'process.exit(0)'\n```\n");
  const r = await reverifyAc({ slug: 's2', cwd }, { resolvePrdPath: () => prdPath });
  expect(r.status).toBe('pass');
  expect('criteriaChecks' in r).toBe(false);
});

// ── httpRetry ────────────────────────────────────────────────────────────

const {
  HTTP_RETRY_ATTEMPTS,
  HTTP_RETRY_DELAY_MS,
} = require('../criteriaChecks.cjs');

function countingSleep(onSleep) {
  const calls = [];
  const sleep = async (ms) => { calls.push(ms); if (onSleep) await onSleep(calls.length); };
  return { calls, sleep };
}

test('httpRetry constants match the PRD contract', () => {
  expect(HTTP_RETRY_ATTEMPTS).toBe(3);
  expect(HTTP_RETRY_DELAY_MS).toBe(10_000);
});

test('httpRetry (a): 404 then 200 passes on attempt 2', async () => {
  let hits = 0;
  const port = await listen((req, res) => { hits++; res.statusCode = hits === 1 ? 404 : 200; res.end('x'); });
  const { calls, sleep } = countingSleep();
  const [r] = await runCriteriaChecks({
    cwd: mkcwd(),
    httpRetry: { delayMs: 5, sleep },
    criteria: [crit('r-a', 'http', `http://127.0.0.1:${port}/`)],
  });
  expect(r).toEqual({ id: 'r-a', kind: 'http', ok: true, detail: 'HTTP 200', attempts: 2 });
  expect(calls).toEqual([5]);
});

test('httpRetry (b): connection refused, then the server comes up during the wait', async () => {
  const probe = http.createServer();
  await new Promise((res) => probe.listen(0, '127.0.0.1', res));
  const port = probe.address().port;
  await new Promise((res) => probe.close(res));
  const srv = http.createServer((req, res) => { res.statusCode = 200; res.end('up'); });
  try {
    const { calls, sleep } = countingSleep(async () => {
      if (srv.listening) return;
      await new Promise((res) => { srv.once('listening', res); srv.listen(port, '127.0.0.1'); });
    });
    const [r] = await runCriteriaChecks({
      cwd: mkcwd(),
      httpRetry: { delayMs: 5, sleep },
      criteria: [crit('r-b', 'http', `http://127.0.0.1:${port}/`)],
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(calls).toEqual([5]);
  } finally {
    await new Promise((res) => (srv.listening ? srv.close(res) : res()));
  }
});

test('httpRetry (c): always 404 fails after 3 attempts with the last detail and two waits', async () => {
  let hits = 0;
  const port = await listen((req, res) => { hits++; res.statusCode = 404; res.end('x'); });
  const { calls, sleep } = countingSleep();
  const [r] = await runCriteriaChecks({
    cwd: mkcwd(),
    httpRetry: { delayMs: 5, sleep },
    criteria: [crit('r-c', 'http', `http://127.0.0.1:${port}/`)],
  });
  expect(r).toEqual({ id: 'r-c', kind: 'http', ok: false, detail: 'HTTP 404, expected 200', attempts: 3 });
  expect(hits).toBe(3);
  expect(calls).toEqual([5, 5]);
});

test('httpRetry (d): waits are shared by the round, passing checks never wait, attempts clamp to 3', async () => {
  const port = await listen((req, res) => { res.statusCode = req.url === '/ok' ? 200 : 404; res.end('x'); });
  const two = countingSleep();
  const rows = await runCriteriaChecks({
    cwd: mkcwd(),
    httpRetry: { attempts: 9, delayMs: 5, sleep: two.sleep },
    criteria: [
      crit('d-1', 'http', `http://127.0.0.1:${port}/a`),
      crit('d-ok', 'http', `http://127.0.0.1:${port}/ok`),
      crit('d-2', 'http', `http://127.0.0.1:${port}/b`),
      crit('d-file', 'file', 'missing.txt'),
    ],
  });
  expect(two.calls).toEqual([5, 5]);
  expect(rows.map((r) => r.attempts)).toEqual([3, 1, 3, undefined]);
  expect(rows.map((r) => r.ok)).toEqual([false, true, false, false]);
  expect('attempts' in rows[3]).toBe(false);

  const pass = countingSleep();
  const [ok] = await runCriteriaChecks({
    cwd: mkcwd(),
    httpRetry: { delayMs: 5, sleep: pass.sleep },
    criteria: [crit('d-pass', 'http', `http://127.0.0.1:${port}/ok`)],
  });
  expect(ok.attempts).toBe(1);
  expect(pass.calls).toEqual([]);

  for (const bad of [0, -2, 1.5, 'x']) {
    const s = countingSleep();
    const [r] = await runCriteriaChecks({
      cwd: mkcwd(),
      httpRetry: { attempts: bad, delayMs: 5, sleep: s.sleep },
      criteria: [crit('d-bad', 'http', `http://127.0.0.1:${port}/a`)],
    });
    expect(r.attempts).toBe(bad === 0 || bad === -2 ? 1 : 3);
  }
});

test('httpRetry (e): a non-loopback refusal is attempted once and never waits', async () => {
  const { calls, sleep } = countingSleep();
  const rows = await runCriteriaChecks({
    cwd: mkcwd(),
    httpRetry: { delayMs: 5, sleep },
    criteria: [
      crit('e-remote', 'http', 'https://example.com/'),
      crit('e-proto', 'http', 'ftp://127.0.0.1/'),
      crit('e-bad', 'http', 'not a url'),
      crit('e-cred', 'http', 'http://u:p@127.0.0.1/'),
    ],
  });
  expect(rows.map((r) => r.attempts)).toEqual([1, 1, 1, 1]);
  expect(rows.every((r) => r.ok === false)).toBe(true);
  expect(rows[0].detail).toMatch(/loopback/);
  for (const r of rows) expect('refused' in r).toBe(false);
  expect(calls).toEqual([]);
});

test('httpRetry with keepBody: the re-run replaces body fields in place', async () => {
  let hits = 0;
  const port = await listen((req, res) => { hits++; res.statusCode = hits === 1 ? 503 : 200; res.end(hits === 1 ? 'down' : 'fresh'); });
  const { sleep } = countingSleep();
  const [r] = await runCriteriaChecks({
    cwd: mkcwd(),
    keepBody: true,
    httpRetry: { delayMs: 5, sleep },
    criteria: [crit('kb', 'http', `http://127.0.0.1:${port}/`)],
  });
  expect(r).toEqual({ id: 'kb', kind: 'http', ok: true, detail: 'HTTP 200', body: 'fresh', bodyBytes: 5, truncated: false, attempts: 2 });
});
