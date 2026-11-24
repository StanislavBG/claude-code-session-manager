/**
 * mcpAdminRouteContract.test.cjs — every admin route an MCP tool calls is one the
 * app registers. Collects each adminRequest(METHOD, path) call in
 * scripts/scheduler-mcp-server.cjs and each { method, path } request object in
 * src/main/lib/feedback-remote/serviceMcpTools.cjs, then checks METHOD + pathname
 * against registerAppAdminRoutes (src/main/adminRouteRegistry.cjs) run on a
 * recording fake.
 *
 * It reads the MCP sources on purpose, to pin every call site: running each tool
 * instead would need hand-made arguments for all 50+ tools. The sources are parsed
 * with the TypeScript compiler API, not regexes.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/mcpAdminRouteContract.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { registerAppAdminRoutes } = require('../adminRouteRegistry.cjs');

const REPO = path.join(__dirname, '../../..');
const MCP_SERVER_REL = 'scripts/scheduler-mcp-server.cjs';
const SERVICE_TOOLS_REL = 'src/main/lib/feedback-remote/serviceMcpTools.cjs';

function parse(text, fileName) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function pathText(arg) {
  if (!arg) return null;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) return arg.head.text;
  return null;
}

/** Every adminRequest(...) call: literal METHOD + pathname, or unparseable. */
function collectAdminCalls(text, fileName) {
  const sf = parse(text, fileName);
  const calls = [];
  const unparseable = [];
  walk(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isIdentifier(node.expression) || node.expression.text !== 'adminRequest') return;
    const line = lineOf(sf, node);
    const [m, p] = node.arguments;
    const raw = pathText(p);
    if (!m || !ts.isStringLiteral(m) || raw === null) {
      unparseable.push({ file: fileName, line });
      return;
    }
    calls.push({ file: fileName, line, method: m.text, pathname: raw.split('?')[0] });
  });
  return { calls, unparseable };
}

function propInit(obj, name) {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name && ts.isIdentifier(prop.name) && prop.name.text === name) {
      return prop.initializer;
    }
  }
  return null;
}

/** Every object literal with string-literal `method` and `path` properties. */
function collectRequestObjects(text, fileName) {
  const sf = parse(text, fileName);
  const calls = [];
  walk(sf, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const m = propInit(node, 'method');
    const p = propInit(node, 'path');
    if (!m || !p || !ts.isStringLiteral(m) || !ts.isStringLiteral(p)) return;
    calls.push({ file: fileName, line: lineOf(sf, node), method: m.text, pathname: p.text.split('?')[0] });
  });
  return calls;
}

function registeredRoutes() {
  const set = new Set();
  registerAppAdminRoutes(
    { registerRoute(m, p) { set.add(`${m} ${p}`); } },
    { onMacrosChanged() {}, onNeedsYouChanged() {} },
  );
  return set;
}

function findMisses(calls, set) {
  return calls.filter((c) => !set.has(`${c.method} ${c.pathname}`));
}

function describeMisses(misses) {
  return misses.map((c) => `${c.file}:${c.line} ${c.method} ${c.pathname}`).join('\n');
}

test('every MCP admin call names a route the app registers', () => {
  const server = collectAdminCalls(fs.readFileSync(path.join(REPO, MCP_SERVER_REL), 'utf8'), MCP_SERVER_REL);
  const service = collectRequestObjects(fs.readFileSync(path.join(REPO, SERVICE_TOOLS_REL), 'utf8'), SERVICE_TOOLS_REL);

  expect(server.unparseable.map((u) => `${u.file}:${u.line}`).join('\n')).toBe('');
  expect(server.calls.length).toBeGreaterThanOrEqual(50);
  expect(service.length).toBeGreaterThanOrEqual(6);
  const keys = server.calls.map((c) => `${c.method} ${c.pathname}`);
  expect(keys).toContain('GET /admin/site-feedback/inbox');
  expect(keys).toContain('GET /admin/customer-feedback/inbox');

  const set = registeredRoutes();
  const misses = findMisses([...server.calls, ...service], set);
  expect(describeMisses(misses), 'MCP tools call admin routes the app does not register').toBe('');
});

test('a call to an unregistered route is one miss', () => {
  const { calls, unparseable } = collectAdminCalls(
    "async function f() { await adminRequest('GET', '/admin/no-such-route'); }",
    'fixture.cjs',
  );
  expect(unparseable).toEqual([]);
  const misses = findMisses(calls, registeredRoutes());
  expect(misses).toEqual([{ file: 'fixture.cjs', line: 1, method: 'GET', pathname: '/admin/no-such-route' }]);
  expect(describeMisses(misses)).toBe('fixture.cjs:1 GET /admin/no-such-route');
});

test('a call with a variable path is one unparseable call', () => {
  const { calls, unparseable } = collectAdminCalls(
    "async function f(p) {\n  await adminRequest('GET', p);\n}",
    'fixture.cjs',
  );
  expect(calls).toEqual([]);
  expect(unparseable).toEqual([{ file: 'fixture.cjs', line: 2 }]);
});

test('query strings and template tails are cut from the pathname', () => {
  const { calls } = collectAdminCalls(
    "adminRequest('GET', '/admin/a?x=1'); adminRequest('GET', `/admin/b?${q}`); adminRequest('POST', `/admin/c`);",
    'fixture.cjs',
  );
  expect(calls.map((c) => `${c.method} ${c.pathname}`)).toEqual(['GET /admin/a', 'GET /admin/b', 'POST /admin/c']);
});
