// scheduler_create_prds MCP tool: drives the exported handleCallTool with a
// stubbed fetch (the admin API) and a temp admin-token file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleCallTool } = require('../../../scripts/scheduler-mcp-server.cjs');

const ENV_KEYS = ['SM_ADMIN_TOKEN_PATH', 'SM_SCHEDULER_JOB_SLUG', 'SM_SCHEDULER_JOB_MAY_QUEUE', 'SM_CHAT_SESSION_ID', 'SM_PROJECT_ROOT'];
const saved = {};
let dir;
let calls;
let reply;

const prd = (slug, extra = {}) => ({
  title: slug, goal: 'g', acceptanceCriteria: ['a'], implementationNotes: 'n',
  gate: ['none'], files: ['a.txt'], slug, ...extra,
});
const call = (args) => handleCallTool({ params: { name: 'scheduler_create_prds', arguments: args } });
const textOf = (r) => r.content[0].text;

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-prds-'));
  process.env.SM_ADMIN_TOKEN_PATH = path.join(dir, 'admin-api.json');
  fs.writeFileSync(process.env.SM_ADMIN_TOKEN_PATH, JSON.stringify({ port: 4321, token: 'tok' }));
  calls = [];
  reply = { ok: true, applied: true, prds: [] };
  vi.stubGlobal('fetch', async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { status: 200, json: async () => reply };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('scheduler_create_prds', () => {
  it('forwards the batch and origin fields to /admin/scheduler/create-prds', async () => {
    process.env.SM_CHAT_SESSION_ID = 'chat-1';
    process.env.SM_PROJECT_ROOT = '/proj';
    reply = { ok: true, applied: true, prds: [{ slug: 'a', nn: 7, warnings: [] }] };
    await call({ prds: [prd('a')], cwd: '/proj' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:4321/admin/scheduler/create-prds');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].body.prds).toHaveLength(1);
    expect(calls[0].body.cwd).toBe('/proj');
    expect(calls[0].body.originClaudeSessionId).toBe('chat-1');
    expect(calls[0].body.originProjectRoot).toBe('/proj');
  });

  it('lists deliverable/artifactPaths in the schema and forwards them', async () => {
    const { TOOLS } = require('../../../scripts/scheduler-mcp-server.cjs');
    const one = TOOLS.find((t) => t.name === 'scheduler_create_prd');
    const many = TOOLS.find((t) => t.name === 'scheduler_create_prds');
    for (const props of [one.inputSchema.properties, many.inputSchema.properties.prds.items.properties]) {
      expect(props.deliverable.enum).toEqual(['artifact']);
      expect(props.artifactPaths.type).toBe('array');
    }
    await call({ prds: [prd('a', { deliverable: 'artifact', artifactPaths: ['out/x.txt'] })] });
    expect(calls[0].body.prds[0].deliverable).toBe('artifact');
    expect(calls[0].body.prds[0].artifactPaths).toEqual(['out/x.txt']);
  });

  it('does not forward originClaudeSessionId when sourcePromptId is given', async () => {
    process.env.SM_CHAT_SESSION_ID = 'chat-1';
    await call({ prds: [prd('a')], sourcePromptId: 'epic-1' });
    expect(calls[0].body.sourcePromptId).toBe('epic-1');
    expect(calls[0].body.originClaudeSessionId).toBeUndefined();
  });

  it('refuses from a headless job unless MAY_QUEUE=1', async () => {
    process.env.SM_SCHEDULER_JOB_SLUG = '12-some-job';
    const r = await call({ prds: [prd('a')] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('refused');
    expect(textOf(r)).toContain('12-some-job');
    expect(calls).toHaveLength(0);

    process.env.SM_SCHEDULER_JOB_MAY_QUEUE = '1';
    reply = { ok: true, applied: true, prds: [{ slug: 'a', nn: 1, warnings: [] }] };
    const ok = await call({ prds: [prd('a')] });
    expect(ok.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('rejects an empty or missing prds array without calling the API', async () => {
    expect((await call({ prds: [] })).isError).toBe(true);
    expect((await call({})).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('lists "<slug> -> <NN>" and every entry\'s warnings on success', async () => {
    reply = { ok: true, applied: true, prds: [
      { slug: 'first', nn: 11, warnings: ['too big'] },
      { slug: 'second', nn: 12, warnings: [] },
      { slug: 'third', nn: 13, warnings: ['no gate', 'odd files'] },
    ] };
    const r = await call({ prds: [prd('first'), prd('second'), prd('third')] });
    const t = textOf(r);
    expect(r.isError).toBeUndefined();
    expect(t).toContain('first -> 11');
    expect(t).toContain('second -> 12');
    expect(t).toContain('third -> 13');
    expect(t).toContain('- first: too big');
    expect(t).toContain('- third: no gate');
    expect(t).toContain('- third: odd files');
  });

  it('lists every per-entry error and says nothing was written on ok:false', async () => {
    reply = { ok: false, applied: false, errors: [
      { index: 0, slug: 'a', error: 'bad gate' },
      { index: 2, slug: 'c', error: 'dependsOn cycle' },
    ] };
    const r = await call({ prds: [prd('a'), prd('b'), prd('c')] });
    const t = textOf(r);
    expect(r.isError).toBe(true);
    expect(t).toContain('nothing was written');
    expect(t).toContain('[0] a: bad gate');
    expect(t).toContain('[2] c: dependsOn cycle');
  });

  it('renders zod details: entry index, slug and field path for an over-long fixes reason', async () => {
    reply = { ok: false, applied: false, error: 'invalid PRD batch payload', details: [
      { code: 'too_big', maximum: 200, path: ['prds', 2, 'fixes', 0, 'reason'], message: 'String must contain at most 200 character(s)' },
    ] };
    const r = await call({ prds: [prd('a'), prd('b'), prd('c')] });
    const t = textOf(r);
    expect(r.isError).toBe(true);
    expect(t).toContain('nothing was written');
    expect(t).toContain('- [2] c: fixes[0].reason: String must contain at most 200 character(s)');
    expect(t).not.toContain('[-1] (no slug): invalid PRD batch payload');
  });

  it('prints a non-prds issue path under [-1] with its full path', async () => {
    reply = { ok: false, applied: false, error: 'invalid PRD batch payload', details: [
      { path: ['cwd'], message: 'Expected string, received number' },
      { path: ['prds', 0], message: 'Required' },
    ] };
    const t = textOf(await call({ prds: [prd('a')] }));
    expect(t).toContain('- [-1] (no slug): cwd: Expected string, received number');
    expect(t).toContain('- [0] a: (root): Required');
  });

  it('caps the issue lines at 20 plus a "+N more" line', async () => {
    const details = Array.from({ length: 25 }, (_, i) => ({ path: ['prds', 0, 'acceptanceCriteria', i], message: `bad ${i}` }));
    reply = { ok: false, applied: false, error: 'invalid PRD batch payload', details };
    const t = textOf(await call({ prds: [prd('a')] }));
    const lines = t.split('\n').filter((l) => l.startsWith('- [0] a: acceptanceCriteria['));
    expect(lines).toHaveLength(20);
    expect(t).toContain('- [0] a: acceptanceCriteria[19]: bad 19');
    expect(t).not.toContain('bad 20');
    expect(t).toContain('+5 more');
  });

  it('prints a refusal with no details exactly as before', async () => {
    reply = { ok: false, applied: false, error: 'invalid PRD batch payload' };
    const t = textOf(await call({ prds: [prd('a')] }));
    expect(t).toContain('Fix every entry below and call again:\n- [-1] (no slug): invalid PRD batch payload — call session_manager_help');
    reply = { ok: false, applied: false, error: 'invalid PRD batch payload', details: 'not an array' };
    expect(textOf(await call({ prds: [prd('a')] }))).toContain('- [-1] (no slug): invalid PRD batch payload');
  });

  it('prints the errors lines, not the details lines, when a refusal carries both', async () => {
    reply = { ok: false, applied: false, error: 'invalid PRD batch payload',
      errors: [{ index: 1, slug: 'b', error: 'dependsOn cycle' }],
      details: [{ path: ['prds', 0, 'goal'], message: 'Required' }] };
    const r = await call({ prds: [prd('a'), prd('b')] });
    const t = textOf(r);
    expect(r.isError).toBe(true);
    expect(t).toContain('- [1] b: dependsOn cycle');
    expect(t).not.toContain('goal: Required');
  });
});

describe('scheduler_create_prd zod details', () => {
  it('shows the field path and message when the admin route returns zod details', async () => {
    reply = { ok: false, error: 'invalid PRD payload', details: [
      { path: ['fixes', 0, 'reason'], message: 'String must contain at most 200 character(s)' },
    ] };
    const r = await handleCallTool({ params: { name: 'scheduler_create_prd', arguments: prd('solo') } });
    const t = textOf(r);
    expect(calls[0].url).toBe('http://127.0.0.1:4321/admin/scheduler/create-prd');
    expect(t).toContain('- fixes[0].reason: String must contain at most 200 character(s)');
  });

  it('returns an ok:false refusal as isError with the JSON, detail lines and help pointer', async () => {
    reply = { ok: false, error: 'invalid PRD payload', details: [
      { path: ['goal'], message: 'Required' },
    ] };
    const r = await handleCallTool({ params: { name: 'scheduler_create_prd', arguments: prd('solo') } });
    const t = textOf(r);
    expect(r.isError).toBe(true);
    expect(t).toContain(JSON.stringify(reply));
    expect(t).toContain('- goal: Required');
    expect(t).toMatch(/call session_manager_help[^\n]*$/);
    expect(t).not.toContain('PRD file written');
  });

  it('returns successful creates (incl. alreadyExisted) as non-errors', async () => {
    for (const r0 of [{ ok: true, filename: '7-solo.md' }, { ok: true, alreadyExisted: true, filename: '7-solo.md' }]) {
      reply = r0;
      const r = await handleCallTool({ params: { name: 'scheduler_create_prd', arguments: prd('solo') } });
      expect(r.isError).toBeUndefined();
      expect(textOf(r)).toBe(`${JSON.stringify(r0)} — PRD file written; the queue row is derived on the next scheduler reconcile pass, not by this call.`);
    }
  });
});
