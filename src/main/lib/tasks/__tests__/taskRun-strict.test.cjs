/**
 * taskRun-strict.test.cjs — a Task always runs under --strict-mcp-config and
 * loads exactly the persona's declared MCP servers (never the ambient
 * user/project MCP config), and every seed persona that names an mcp__ tool
 * declares the matching `mcpServers:` so strict mode does not strip it.
 *
 * Run: timeout 300 npx vitest run src/main/lib/tasks/__tests__/taskRun-strict.test.cjs
 */
'use strict';

import { test, expect, describe } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildTaskArgs } = require('../taskRun.cjs');
const { splitFrontmatter } = require('../../prd/prdFrontmatter.cjs');
const { parseCapabilityList } = require('../../../agentLibrary.cjs');
const { registerAdminRoute } = require('../taskAdminRoutes.cjs');

const PROJ = path.resolve(os.tmpdir(), 'sm-taskrun-strict-proj');
const SCHED = { command: 'node', args: ['/x/scheduler-mcp-server.cjs'] };
const KNOWN = { 'session-manager-scheduler': SCHED, other: { command: 'other' } };

/** Every server the argv's --mcp-config list loads inline (file paths are skipped). */
function inlineServers(args) {
  const i = args.indexOf('--mcp-config');
  if (i === -1) return [];
  const names = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) {
    if (args[j].trim().startsWith('{')) names.push(...Object.keys(JSON.parse(args[j]).mcpServers));
  }
  return names;
}

describe('buildTaskArgs — strict MCP', () => {
  test('no declared servers: --strict-mcp-config, and no --mcp-config at all', () => {
    for (const runtime of [{}, { strictMcpConfig: false }, { strictMcpConfig: true }]) {
      const args = buildTaskArgs({ model: 'm', effort: 'e', projectCwd: PROJ, runtime, knownMcpServers: KNOWN });
      expect(args).toContain('--strict-mcp-config');
      expect(args.filter((a) => a === '--strict-mcp-config')).toHaveLength(1);
      expect(args).not.toContain('--mcp-config');
    }
  });

  test('declared servers: strict, and --mcp-config carries only the declared ones', () => {
    const args = buildTaskArgs({
      model: 'm', effort: 'e', projectCwd: PROJ, runtime: { strictMcpConfig: false },
      declaredMcpServers: ['session-manager-scheduler'], knownMcpServers: KNOWN,
    });
    expect(args).toContain('--strict-mcp-config');
    expect(inlineServers(args)).toEqual(['session-manager-scheduler']);
    const json = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
    expect(json.mcpServers['session-manager-scheduler']).toEqual(SCHED);
    // --mcp-config is variadic: the next flag ends it.
    expect(args[args.indexOf('--mcp-config') + 2]).toBe('--output-format');
  });

  test('a declared server that resolves nowhere is refused, never widened', () => {
    let err;
    try {
      buildTaskArgs({ model: 'm', effort: 'e', projectCwd: PROJ, declaredMcpServers: ['nope'], knownMcpServers: KNOWN });
    } catch (e) { err = e; }
    expect(err && err.code).toBe('capability_unknown');
    expect(String(err.message)).toContain('nope');
  });
});

describe('Task route passes the persona declared set', () => {
  test('resolveInfo.declaredMcpServers reaches buildTaskArgs with the known server map', async () => {
    /** @type {any} */
    let seen = null;
    const routes = {};
    registerAdminRoute({ registerRoute: (m, p, h) => { routes[`${m} ${p}`] = h; } }, {
      taskSwitch: { isTaskSwitchOn: () => true },
      resolveProjectRoot: (c) => c,
      resolveInfo: async () => ({ personaFound: true, resolvedModelId: 'sonnet', personaEffort: 'low', declaredMcpServers: ['session-manager-scheduler'] }),
      buildTaskArgs: (o) => { seen = o; const e = new Error('stop'); /** @type {any} */ (e).code = 'stop_here'; throw e; },
      ledger: { appendTaskStart: async () => {}, appendTaskEnd: async () => {} },
      usageHold: () => null,
      appendAuditEvent: () => {},
    });
    const handler = routes['POST /admin/tasks'];
    expect(typeof handler).toBe('function');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskstrict-'));
    try {
      const { Readable } = require('node:stream');
      const body = JSON.stringify({ cwd, agent: 'project-home-builder', missionId: 'm1', prompt: 'hi' });
      const req = Object.assign(Readable.from([Buffer.from(body)]), { headers: { 'content-type': 'application/json' }, method: 'POST' });
      /** @type {any} */
      const out = { status: 0, body: '' };
      const res = {
        on() {}, setHeader() {}, writeHead(s) { out.status = s; },
        end(b) { out.body = String(b || ''); }, get headersSent() { return out.status !== 0; },
      };
      await handler(req, res);
      expect(seen).not.toBeNull();
      expect(seen.declaredMcpServers).toEqual(['session-manager-scheduler']);
      expect(Object.keys(seen.knownMcpServers)).toContain('session-manager-scheduler');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('Task route resolves user-scope servers', () => {
  test('a user-scope server declared by the persona reaches buildTaskArgs and --mcp-config', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskhome-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskcwd-'));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'user-srv': { command: 'node', args: ['x.js'] } } }));
    /** @type {any} */
    let seen = null;
    const routes = {};
    registerAdminRoute({ registerRoute: (m, p, h) => { routes[`${m} ${p}`] = h; } }, {
      mcpHome: home,
      taskSwitch: { isTaskSwitchOn: () => true },
      resolveProjectRoot: (c) => c,
      resolveInfo: async () => ({ personaFound: true, resolvedModelId: 'sonnet', personaEffort: 'low', declaredMcpServers: ['user-srv'] }),
      buildTaskArgs: (o) => { seen = o; const e = new Error('stop'); /** @type {any} */ (e).code = 'stop_here'; throw e; },
      ledger: { appendTaskStart: async () => {}, appendTaskEnd: async () => {} },
      usageHold: () => null,
      appendAuditEvent: () => {},
    });
    try {
      const { Readable } = require('node:stream');
      const body = JSON.stringify({ cwd, agent: 'a', missionId: 'm1', prompt: 'hi' });
      const req = Object.assign(Readable.from([Buffer.from(body)]), { headers: { 'content-type': 'application/json' }, method: 'POST' });
      const out = { status: 0 };
      const res = { on() {}, setHeader() {}, writeHead(s) { out.status = s; }, end() {}, get headersSent() { return out.status !== 0; } };
      await routes['POST /admin/tasks'](req, res);
      expect(Object.keys(seen.knownMcpServers)).toContain('user-srv');
      const args = buildTaskArgs({ model: 'm', effort: 'e', projectCwd: cwd, declaredMcpServers: ['user-srv'], knownMcpServers: seen.knownMcpServers });
      expect(inlineServers(args)).toContain('user-srv');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

 describe('Task route refuses credentialed servers', () => {
  test('400 capability_credentialed with the resolver reason', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskhome-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskcwd-'));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'secret-srv': { command: 'node', env: { API_TOKEN: 'abc' } } } }));
    let built = false;
    const routes = {};
    registerAdminRoute({ registerRoute: (m, p, h) => { routes[`${m} ${p}`] = h; } }, {
      mcpHome: home,
      taskSwitch: { isTaskSwitchOn: () => true },
      resolveProjectRoot: (c) => c,
      resolveInfo: async () => ({ personaFound: true, resolvedModelId: 'sonnet', personaEffort: 'low', declaredMcpServers: ['secret-srv'] }),
      buildTaskArgs: () => { built = true; return []; },
      ledger: { appendTaskStart: async () => {}, appendTaskEnd: async () => {} },
      usageHold: () => null,
      appendAuditEvent: () => {},
    });
    try {
      const { Readable } = require('node:stream');
      const body = JSON.stringify({ cwd, agent: 'a', missionId: 'm1', prompt: 'hi' });
      const req = Object.assign(Readable.from([Buffer.from(body)]), { headers: { 'content-type': 'application/json' }, method: 'POST' });
      const out = { status: 0, body: '' };
      const res = { on() {}, setHeader() {}, writeHead(s) { out.status = s; }, end(b) { out.body = String(b || ''); }, get headersSent() { return out.status !== 0; } };
      await routes['POST /admin/tasks'](req, res);
      expect(out.status).toBe(400);
      expect(out.body).toContain('capability_credentialed');
      expect(out.body).toContain('credential key API_TOKEN');
      expect(built).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('seed personas declare the MCP servers their tools name', () => {
  const dir = path.resolve(__dirname, '../../../../seed/agents');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    test(file, () => {
      const { fm } = splitFrontmatter(fs.readFileSync(path.join(dir, file), 'utf8'));
      const tools = parseCapabilityList(fm.tools);
      const needed = [...new Set(tools.filter((t) => t.startsWith('mcp__')).map((t) => t.slice(5).split('__')[0]))].sort();
      const declared = parseCapabilityList(fm.mcpServers);
      for (const n of needed) expect(declared, `${file} must declare mcpServers: ${n}`).toContain(n);
    });
  }
});
