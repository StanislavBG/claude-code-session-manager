/**
 * prdFixesApiSurface.test.cjs — the `fixes` create input (PRD prd-fixes-field)
 * reaches agents: scheduler_create_prd and every scheduler_create_prds entry
 * list it with the MISS_KINDS enum, and the admin create route's zod schema
 * keeps it (instead of silently stripping it) on its way to createPrd.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/prdFixesApiSurface.test.cjs
 */
'use strict';

import { test, expect, beforeEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const config = require('../../config.cjs');
const { FIXES_DESCRIPTION } = require('../mcpToolCatalog.cjs');
const { MISS_KINDS } = require('../scheduler/validatorVerdictSchema.cjs');
const { registerAdminRoute } = require('../prd/prdCreate.cjs');
const { schemas } = require('../../ipcSchemas.cjs');
const { TOOLS } = require(path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs'));

const EXPECTED_DESCRIPTION = 'Optional: the earlier PRDs this PRD repairs, each with its miss kind and a one-line reason. '
  + 'Name every PRD whose bug this PRD fixes; one that already had a VERIFIED verdict counts as a validator miss (escape).';

function expectFixesProperty(props) {
  const fixes = props.fixes;
  expect(fixes).toBeTruthy();
  expect(fixes.type).toBe('array');
  expect(fixes.description).toBe(EXPECTED_DESCRIPTION);
  expect(fixes.items.type).toBe('object');
  expect(Object.keys(fixes.items.properties).sort()).toEqual(['missKind', 'prd', 'reason']);
  expect(fixes.items.properties.missKind.enum).toEqual([...MISS_KINDS]);
  expect(fixes.items.required).toEqual(['prd', 'missKind', 'reason']);
}

test('catalog description is the exact agreed text', () => {
  expect(FIXES_DESCRIPTION).toBe(EXPECTED_DESCRIPTION);
});

test('scheduler_create_prd input schema lists fixes with the MISS_KINDS enum', () => {
  const tool = TOOLS.find((t) => t.name === 'scheduler_create_prd');
  expect(tool).toBeTruthy();
  expectFixesProperty(tool.inputSchema.properties);
});

test('each scheduler_create_prds entry schema lists fixes with the MISS_KINDS enum', () => {
  const tool = TOOLS.find((t) => t.name === 'scheduler_create_prds');
  expect(tool).toBeTruthy();
  expectFixesProperty(tool.inputSchema.properties.prds.items.properties);
});

// ── admin create route: fixes passes through to createPrd unchanged

let cwd;
let rows;
let written;
let remote;
let handlers;

beforeEach(async () => {
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-fixes-api-'));
  config.addAllowedRoot(cwd);
  rows = [{ slug: '3601-earlier-thing', epicId: 'epic-a', status: 'completed' }];
  written = [];
  let nn = 3700;
  remote = {
    async allocateParallelGroup() { return nn++; },
    async readPrd() { return { ok: false }; },
    async writePrd(slug, body) {
      written.push({ slug, body });
      rows.push({ slug, epicId: 'epic-a', status: 'pending' });
      return { ok: true, path: path.join(cwd, `${slug}.md`), epicId: 'epic-a' };
    },
    async listPrds() { return { prds: rows, total: rows.length, limit: rows.length, offset: 0, hasMore: false }; },
  };
  handlers = new Map();
  registerAdminRoute({ registerRoute(method, url, fn) { handlers.set(`${method} ${url}`, fn); } }, remote);
});

async function callRoute(url, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  let status = 0;
  let text = '';
  const res = {
    writeHead(s) { status = s; },
    end(b) { text = b ?? ''; },
  };
  await handlers.get(`POST ${url}`)(req, res);
  return { status, json: JSON.parse(text) };
}

const FIXES = [{ prd: '3601-earlier-thing', missKind: 'behavior-wrong', reason: 'dropped the field on save' }];

const entry = (o = {}) => ({
  title: 'Repair the earlier thing', slug: 'repair-earlier-thing', cwd, sourcePromptId: 'epic-a',
  goal: 'g', acceptanceCriteria: ['a'], implementationNotes: 'n',
  gate: ['timeout 60 npm run typecheck'], files: ['src/x.cjs'], ...o,
});

/** The `fixes:` frontmatter line createPrd wrote, parsed back. */
function writtenFixes(body) {
  const m = /^fixes: (.+)$/m.exec(body);
  return m ? JSON.parse(m[1]) : null;
}

test('zod create schemas keep fixes unchanged', () => {
  expect(schemas.schedulerCreatePrd.parse(entry({ fixes: FIXES })).fixes).toEqual(FIXES);
  expect(schemas.adminCreatePrds.parse({ prds: [entry({ fixes: FIXES })] }).prds[0].fixes).toEqual(FIXES);
});

test('POST create-prd with fixes reaches createPrd with the same array', async () => {
  const res = await callRoute('/admin/scheduler/create-prd', entry({ fixes: FIXES }));
  expect(res.status).toBe(200);
  expect(written).toHaveLength(1);
  expect(writtenFixes(written[0].body)).toEqual(FIXES);
});

test('POST create-prds with fixes on an entry reaches createPrdBatch with the same array', async () => {
  const res = await callRoute('/admin/scheduler/create-prds', { prds: [entry({ fixes: FIXES })] });
  expect(res.status).toBe(200);
  expect(written).toHaveLength(1);
  expect(writtenFixes(written[0].body)).toEqual(FIXES);
});

test('POST create-prd refuses a non-array fixes and writes nothing', async () => {
  const res = await callRoute('/admin/scheduler/create-prd', entry({ fixes: FIXES[0] }));
  expect(res.status).toBe(400);
  expect(res.json.ok).toBe(false);
  expect(written).toHaveLength(0);
});

test('POST create-prd refuses a missKind outside MISS_KINDS', async () => {
  const res = await callRoute('/admin/scheduler/create-prd', entry({ fixes: [{ ...FIXES[0], missKind: 'oops' }] }));
  expect(res.status).toBe(400);
  expect(written).toHaveLength(0);
});
