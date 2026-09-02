/**
 * projectHomeAdminRoutes.test.cjs — unit tests for
 * lib/projectHomeAdminRoutes.cjs, the app-side half of "the generating
 * session needs zero repo knowledge to build a Project Home page" (PRD:
 * project-home-admin-routes).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/projectHomeAdminRoutes.test.cjs
 */

'use strict';

import { test, expect, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const { registerAdminRoute } = require('../lib/projectHomeAdminRoutes.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkProjectCwd() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-project-home-admin-'));
  config.addAllowedRoot(dir);
  fs.mkdirSync(path.join(dir, 'session-manager-operations'), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

/** Fake adminHttp stub — same pattern prdAdminRouteParity.test.cjs uses:
 * captures registered routes and lets a test invoke one directly with a
 * fake req/res/query, no real HTTP server or Electron boot needed. */
function makeFakeAdminHttp() {
  const routes = new Map();
  return {
    registerRoute(method, url, handler) {
      routes.set(`${method} ${url}`, handler);
    },
    async call(method, url, { query = new URLSearchParams(), body } = {}) {
      const handler = routes.get(`${method} ${url}`);
      if (!handler) throw new Error(`no route registered for ${method} ${url}`);
      const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
      const req = {
        on(event, cb) {
          if (event === 'data') chunks.forEach((c) => cb(c));
          if (event === 'end') cb();
          return req;
        },
      };
      let status = null;
      let payload = null;
      const res = {
        writeHead(s) { status = s; },
        end(b) { payload = b ? JSON.parse(b) : null; },
      };
      await handler(req, res, query);
      return { status, body: payload };
    },
    routes,
  };
}

function validSummary(overrides = {}) {
  return {
    identity: {
      name: 'Demo', tag: 'demo', version: '1.0.0', oneLine: 'A demo project.',
      claim: 'Ship faster.', sub: 'Subtitle text.', audience: 'Developers', install: 'npm i demo',
    },
    stats: [{ v: '5', k: 'years', n: 'since launch' }],
    pillars: [{ t: 'Fast', d: 'It is fast.', k: 'speed' }],
    quotes: [],
    feature: {
      name: 'Feature', kicker: 'New', status: 'shipped', owner: 'team', oneLine: 'One line.',
      problem: 'Problem text.', solution: 'Solution text.',
      steps: [{ t: 'Step', d: 'desc' }], rules: [{ t: 'Rule', d: 'desc' }],
      specs: [['label', 'value', 'note']], faq: [{ q: 'Q', a: 'A' }],
      timeline: [{ w: 'W1', t: 'Thing', s: 'done' }],
    },
    architecture: {
      summary: 'Arch summary.',
      principles: [{ t: 'P', d: 'd' }],
      layers: [{ n: 'Layer', d: 'd', f: '5', tone: 'accent' }],
      modules: [{ n: 'Mod', d: 'd', f: 3, dep: [], heat: 1 }],
      flow: [{ a: 'A', b: 'B', t: 't', n: 'n' }],
      decisions: [{ id: 'd1', t: 't', w: 'w', s: 'accepted' }],
      risks: [],
    },
    ...overrides,
  };
}

function picksFromCatalog(catalog) {
  const picks = {};
  for (const lens of catalog.lenses) {
    picks[lens.id] = {};
    for (const slot of lens.slots) {
      picks[lens.id][slot.id] = slot.variants[0].id;
    }
  }
  return picks;
}

// ─── Route registration ────────────────────────────────────────────────
test('registers all four project-home admin routes', () => {
  const fake = makeFakeAdminHttp();
  registerAdminRoute(fake);
  expect(fake.routes.has('GET /admin/project-home/contract')).toBe(true);
  expect(fake.routes.has('POST /admin/project-home/validate-summary')).toBe(true);
  expect(fake.routes.has('POST /admin/project-home/render')).toBe(true);
  expect(fake.routes.has('GET /admin/project-home/status')).toBe(true);
});

// ─── contract ──────────────────────────────────────────────────────────
test('contract: self-sufficient — 5 lenses, non-empty slots, absolute paths, no repo-relative path strings', async () => {
  const cwd = await mkProjectCwd();
  const fake = makeFakeAdminHttp();
  registerAdminRoute(fake);

  const { status, body } = await fake.call('GET', '/admin/project-home/contract', {
    query: new URLSearchParams({ cwd }),
  });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  expect(Array.isArray(body.protocol)).toBe(true);
  expect(body.protocol.length).toBeGreaterThan(0);

  expect(body.catalog.lenses.map((l) => l.id).sort()).toEqual(
    ['architecture', 'brief', 'feature', 'home', 'marketing'].sort(),
  );
  for (const lens of body.catalog.lenses) {
    expect(Array.isArray(lens.slots)).toBe(true);
    expect(lens.slots.length).toBeGreaterThan(0);
  }

  expect(path.isAbsolute(body.paths.summaryPath)).toBe(true);
  expect(path.isAbsolute(body.paths.picksPath)).toBe(true);
  expect(path.isAbsolute(body.paths.outputDir)).toBe(true);
  expect(body.paths.summaryPath).toContain(cwd);

  expect(body.summarySchema).toBeTruthy();
  expect(body.summarySchema.properties.identity).toBeTruthy();

  // The operational fields (catalog/paths/protocol) must never point the
  // caller at a repo-relative path — the whole point of this route. The
  // free-form "spec.text" field is the architecture doc's own prose, which
  // legitimately documents source file locations for background reading;
  // it is explicitly excluded from this check (see route file's loadCatalog
  // comment for why the catalog's own $comment is stripped for the same
  // reason).
  const operationalFields = JSON.stringify({ protocol: body.protocol, catalog: body.catalog, paths: body.paths });
  expect(operationalFields).not.toMatch(/src\/renderer|src\/main|scripts\//);
});

test('contract: rejects a missing/non-absolute cwd with a structured error, not a throw', async () => {
  const fake = makeFakeAdminHttp();
  registerAdminRoute(fake);

  const missing = await fake.call('GET', '/admin/project-home/contract', { query: new URLSearchParams() });
  expect(missing.status).toBe(400);
  expect(missing.body.ok).toBe(false);

  const relative = await fake.call('GET', '/admin/project-home/contract', {
    query: new URLSearchParams({ cwd: 'relative/path' }),
  });
  expect(relative.status).toBe(400);
  expect(relative.body.ok).toBe(false);
});

test('contract: rejects a cwd with no session-manager-operations/ directory', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-not-a-project-'));
  config.addAllowedRoot(dir);
  tmpDirs.push(dir);
  const fake = makeFakeAdminHttp();
  registerAdminRoute(fake);

  const { status, body } = await fake.call('GET', '/admin/project-home/contract', {
    query: new URLSearchParams({ cwd: dir }),
  });
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(body.error).toMatch(/not a Session Manager project/);
});

// ─── validate-summary ──────────────────────────────────────────────────
test('validate-summary: accepts a well-formed summary', async () => {
  const cwd = await mkProjectCwd();
  const fake = makeFakeAdminHttp();
  registerAdminRoute(fake);

  const { status, body } = await fake.call('POST', '/admin/project-home/validate-summary', {
    body: { cwd, summary: validSummary() },
  });
  expect(status).toBe(200);
  expect(body.valid).toBe(true);
  expect(body.errors).toEqual([]);
});

test('validate-summary: rejects a malformed summary with per-field errors', async () => {
  const cwd = await mkProjectCwd();
  const fake = makeFakeAdminHttp();
  registerAdminRoute(fake);

  const bad = validSummary({ identity: { ...validSummary().identity, name: '' } });
  const { status, body } = await fake.call('POST', '/admin/project-home/validate-summary', {
    body: { cwd, summary: bad },
  });
  expect(status).toBe(200);
  expect(body.valid).toBe(false);
  expect(body.errors.length).toBeGreaterThan(0);
  expect(body.errors[0]).toHaveProperty('field');
  expect(body.errors[0]).toHaveProperty('message');
  expect(body.errors.some((e) => e.field === 'identity.name')).toBe(true);
});

// ─── render ────────────────────────────────────────────────────────────
test('render: happy path writes summary.json, picks.json, all 5 lens htmls, and manifest.json', async () => {
  const cwd = await mkProjectCwd();
  const fake = makeFakeAdminHttp();
  registerAdminRoute(fake);

  const contract = await fake.call('GET', '/admin/project-home/contract', { query: new URLSearchParams({ cwd }) });
  const picks = picksFromCatalog(contract.body.catalog);
  const summary = validSummary();

  const { status, body } = await fake.call('POST', '/admin/project-home/render', {
    body: { cwd, summary, picks },
  });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  expect(typeof body.generatedAt).toBe('string');
  expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
  expect(Array.isArray(body.filesWritten)).toBe(true);

  const dir = path.join(cwd, 'session-manager-operations', 'project-pages');
  expect(fs.existsSync(path.join(dir, 'summary.json'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'picks.json'))).toBe(true);
  for (const lens of ['home', 'marketing', 'feature', 'architecture', 'brief']) {
    expect(fs.existsSync(path.join(dir, 'output', `${lens}.html`))).toBe(true);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'output', 'manifest.json'), 'utf8'));
  expect(manifest.generatedAt).toBe(body.generatedAt);

  expect(JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'))).toEqual(summary);
});

test('render: a malformed summary is rejected and writes NOTHING', async () => {
  const cwd = await mkProjectCwd();
  const fake = makeFakeAdminHttp();
  registerAdminRoute(fake);

  const bad = validSummary({ architecture: { ...validSummary().architecture, summary: '' } });
  const { status, body } = await fake.call('POST', '/admin/project-home/render', {
    body: { cwd, summary: bad, picks: {} },
  });
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(body.valid).toBe(false);
  expect(body.errors.length).toBeGreaterThan(0);

  const dir = path.join(cwd, 'session-manager-operations', 'project-pages');
  expect(fs.existsSync(dir)).toBe(false);
});

test('render: a malformed picks shape is rejected with a field error and writes NOTHING', async () => {
  const cwd = await mkProjectCwd();
  const fake = makeFakeAdminHttp();
  registerAdminRoute(fake);

  const { status, body } = await fake.call('POST', '/admin/project-home/render', {
    body: { cwd, summary: validSummary(), picks: { home: { hero: 42 } } },
  });
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(body.errors.some((e) => e.field === 'picks.home.hero')).toBe(true);

  const dir = path.join(cwd, 'session-manager-operations', 'project-pages');
  expect(fs.existsSync(dir)).toBe(false);
});

test('GET routes (contract, status) never widen the write boundary — only render does', async () => {
  // mkProjectCwd() (used by every other test here) calls config.addAllowedRoot
  // itself so validatePath succeeds for an arbitrary os.tmpdir() location —
  // which would defeat this specific assertion. Use a cwd that's readable
  // via validatePath's own default allowed root (os.homedir()) WITHOUT any
  // addAllowedRoot call, so a write only succeeds if a route handler itself
  // called it — matching prdCreate.test.cjs's / prdMigration.test.cjs's own
  // "homedir-rooted tmp cwd" pattern for exactly this kind of check.
  const cwd = fs.realpathSync(await fsp.mkdtemp(path.join(os.homedir(), '.sm-project-home-admin-')));
  tmpDirs.push(cwd);
  fs.mkdirSync(path.join(cwd, 'session-manager-operations'), { recursive: true });

  const fake = makeFakeAdminHttp();
  registerAdminRoute(fake);

  await fake.call('GET', '/admin/project-home/contract', { query: new URLSearchParams({ cwd }) });
  await fake.call('GET', '/admin/project-home/status', { query: new URLSearchParams({ cwd }) });

  // A write through config.cjs for this cwd must still be refused — the
  // GET routes above must not have called config.addAllowedRoot for it.
  const probePath = path.join(cwd, 'session-manager-operations', 'project-pages', 'probe.json');
  await expect(config.writeJson(probePath, { a: 1 }, { writer: 'project-home' })).rejects.toThrow(
    /Write outside allowed write boundaries/,
  );
});

test('render: two concurrent renders for the same cwd are serialized, not interleaved', async () => {
  const cwd = await mkProjectCwd();
  const fake = makeFakeAdminHttp();
  registerAdminRoute(fake);

  const contract = await fake.call('GET', '/admin/project-home/contract', { query: new URLSearchParams({ cwd }) });
  const picks = picksFromCatalog(contract.body.catalog);

  // Distinct summaries so writes for render A vs render B can be told apart
  // by content — identity.oneLine is echoed into every lens's html output
  // (see renderer.cjs's htmlDocument/proj.oneLine usage).
  const summaryA = validSummary({ identity: { ...validSummary().identity, oneLine: 'MARKER_RENDER_A' } });
  const summaryB = validSummary({ identity: { ...validSummary().identity, oneLine: 'MARKER_RENDER_B' } });

  const events = [];
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let gateArmed = false;

  function labelForArgs(args) {
    const text = typeof args[1] === 'string' ? args[1] : JSON.stringify(args[1]);
    if (text.includes('MARKER_RENDER_A')) return 'A';
    if (text.includes('MARKER_RENDER_B')) return 'B';
    return 'unknown';
  }

  const realWriteJson = config.writeJson.bind(config);
  const realWriteTextAtomic = config.writeTextAtomic.bind(config);

  async function instrumented(real, args) {
    const label = labelForArgs(args);
    events.push({ label, phase: 'start' });
    // Only the very first write of the whole test is gated — this is render
    // A's first write, deep inside its own Promise.all of writes. Holding it
    // open gives render B a real window to start writing if serialization
    // were absent; every other write (A's remaining writes, all of B's
    // writes) proceeds unblocked.
    if (!gateArmed) {
      gateArmed = true;
      await gate;
    }
    const result = await real(...args);
    events.push({ label, phase: 'end' });
    return result;
  }

  const writeJsonSpy = vi.spyOn(config, 'writeJson').mockImplementation((...args) => instrumented(realWriteJson, args));
  const writeTextAtomicSpy = vi
    .spyOn(config, 'writeTextAtomic')
    .mockImplementation((...args) => instrumented(realWriteTextAtomic, args));

  try {
    const renderA = fake.call('POST', '/admin/project-home/render', { body: { cwd, summary: summaryA, picks } });
    const renderB = fake.call('POST', '/admin/project-home/render', { body: { cwd, summary: summaryB, picks } });

    // Yield microtasks (no wall-clock wait) until render A's first write has
    // registered, then release it.
    for (let i = 0; i < 1000 && events.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(events.length).toBeGreaterThan(0);
    releaseGate();

    const [resA, resB] = await Promise.all([renderA, renderB]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const labels = events.map((e) => e.label);
    const firstA = labels.indexOf('A');
    const lastA = labels.lastIndexOf('A');
    const firstB = labels.indexOf('B');
    const lastB = labels.lastIndexOf('B');
    expect(firstA).toBeGreaterThanOrEqual(0);
    expect(firstB).toBeGreaterThanOrEqual(0);
    // Serialized means one render's entire write span is fully outside the
    // other's — never interleaved.
    expect(lastA < firstB || lastB < firstA).toBe(true);

    const dir = path.join(cwd, 'session-manager-operations', 'project-pages');
    const outputFiles = fs.readdirSync(path.join(dir, 'output')).sort();
    expect(outputFiles).toEqual([
      'architecture.html',
      'brief.html',
      'feature.html',
      'home.html',
      'manifest.json',
      'marketing.html',
    ]);
  } finally {
    writeJsonSpy.mockRestore();
    writeTextAtomicSpy.mockRestore();
  }
});

// ─── status ────────────────────────────────────────────────────────────
test('status: a project with no output dir yet returns a well-formed all-absent response, not an error', async () => {
  const cwd = await mkProjectCwd();
  const fake = makeFakeAdminHttp();
  registerAdminRoute(fake);

  const { status, body } = await fake.call('GET', '/admin/project-home/status', {
    query: new URLSearchParams({ cwd }),
  });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.summary.exists).toBe(false);
  expect(body.picks.exists).toBe(false);
  expect(body.manifest.exists).toBe(false);
  expect(body.manifest.generatedAt).toBe(null);
  for (const lens of ['home', 'marketing', 'feature', 'architecture', 'brief']) {
    expect(body.output[lens].exists).toBe(false);
  }
});

test('status: reflects what render() just wrote', async () => {
  const cwd = await mkProjectCwd();
  const fake = makeFakeAdminHttp();
  registerAdminRoute(fake);

  const contract = await fake.call('GET', '/admin/project-home/contract', { query: new URLSearchParams({ cwd }) });
  const picks = picksFromCatalog(contract.body.catalog);
  await fake.call('POST', '/admin/project-home/render', { body: { cwd, summary: validSummary(), picks } });

  const { body } = await fake.call('GET', '/admin/project-home/status', { query: new URLSearchParams({ cwd }) });
  expect(body.summary.exists).toBe(true);
  expect(body.picks.exists).toBe(true);
  expect(body.manifest.exists).toBe(true);
  expect(typeof body.manifest.generatedAt).toBe('string');
  for (const lens of ['home', 'marketing', 'feature', 'architecture', 'brief']) {
    expect(body.output[lens].exists).toBe(true);
    expect(typeof body.output[lens].mtimeMs).toBe('number');
  }
});
