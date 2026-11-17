/**
 * crossProjectReply.test.cjs — the return leg of the cross-project conduit
 * (lib/feedback-remote/crossProjectReply.cjs): a session answering a
 * cross-project request replies INTO the Epic that asked.
 *
 * Run: timeout 300 npx vitest run src/main/lib/feedback-remote/__tests__/crossProjectReply.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const config = require('../../../config.cjs');
const { opsPath } = require('../../opsOwnership.cjs');
const { readActiveIndex } = require('../../epic/epicMint.cjs');
const {
  sendFeedbackReply,
  registerAdminRoute,
  composeReplyPrompt,
  MAX_REPLIES_PER_THREAD,
} = require('../crossProjectReply.cjs');
const { MAX_BODY_CHARS, MAX_REFERENCES } = require('../crossProjectFeedback.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

async function mkProject(prefix) {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), `sm-xreply-${prefix}-`));
  config.addAllowedRoot(cwd);
  tmpDirs.push(cwd);
  fs.mkdirSync(path.join(cwd, 'session-manager-operations'), { recursive: true });
  // ensureEpic checks the persona file exists; the fallback mints as 'architect'.
  fs.mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'agents', 'architect.md'), '---\nname: architect\n---\nFixture persona.\n');
  return fs.realpathSync(cwd);
}

function writeIndex(cwd, sessions) {
  const file = opsPath(cwd, 'prompt-sessions', 'active-index.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const events = {};
  for (const id of Object.keys(sessions)) {
    events[id] = [{ id: `pevt-${id}`, promptSessionId: id, kind: 'prompt', causedByEventId: null, at: '2026-01-01T00:00:00.000Z' }];
  }
  fs.writeFileSync(file, JSON.stringify({ sessions, events }));
}

/** A asks (X in projectA), B answers (Y in projectB). */
async function setup({ xOverrides = {}, ySource } = {}) {
  const a = await mkProject('a');
  const b = await mkProject('b');
  writeIndex(a, {
    'psess-x': { id: 'psess-x', cwd: a, status: 'active', claudeSessionId: 'cs-x', goalText: 'Ask B something', ...xOverrides },
  });
  writeIndex(b, {
    'psess-y': {
      id: 'psess-y',
      cwd: b,
      status: 'active',
      claudeSessionId: 'cs-y',
      goalText: 'Relay drops a frame',
      sections: [
        { kind: 'input', part: 'grounding', label: 'Grounding', text: 'g', source: a },
        { kind: 'input', part: 'reference', label: 'Reference', text: 'Reference: docs/original-spec.md', source: 'docs/original-spec.md' },
        { kind: 'mission', part: 'goal', label: 'Goal', text: 'Goal: Relay drops a frame' },
      ],
      source: ySource === undefined
        ? {
            producer: 'cross-project-feedback',
            fromCwd: a,
            fromEpicId: 'psess-x',
            replyTo: { cwd: a, epicId: 'psess-x', claudeSessionId: 'cs-x' },
            proposal: { motivation: 'Phones lose a frame', acceptanceCriteria: ['First frame arrives'], plan: [], outOfScope: [] },
          }
        : ySource,
    },
  });
  return { a, b };
}

function input(b, overrides = {}) {
  return {
    fromCwd: b,
    originClaudeSessionId: 'cs-y',
    message: 'Fixed in commit abc123.',
    outcome: 'done',
    referencePaths: ['src/relay.cjs'],
    ...overrides,
  };
}

function deps(disposition = 'sent', extra = {}) {
  const calls = [];
  const audits = [];
  return {
    calls,
    audits,
    sendPrompt: async (...args) => { calls.push(args); return { disposition }; },
    appendAudit: (kind, fields) => audits.push({ kind, fields }),
    ...extra,
  };
}

const events = (cwd, id) => readActiveIndex(cwd).events[id] || [];

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

test('delivers into an active asking Epic: event on X, prompt to X, receipt on Y, audit', async () => {
  const { a, b } = await setup();
  const d = deps('sent');
  const r = await sendFeedbackReply(input(b), d);
  expect(r).toMatchObject({ ok: true, delivery: 'delivered', toEpicId: 'psess-x' });

  const xEv = events(a, 'psess-x').at(-1);
  expect(xEv.notice).toBe('cross-project-reply');
  expect(xEv.reply).toEqual({ fromCwd: b, fromEpicId: 'psess-y', outcome: 'done', referencePaths: ['src/relay.cjs'] });
  expect(xEv.text.startsWith('REPLY FROM ANOTHER PROJECT:')).toBe(true);

  expect(d.calls).toHaveLength(1);
  const [tabId, prompt, extra] = d.calls[0];
  expect(tabId).toBe('psess-x');
  expect(prompt).toBe(xEv.text);
  expect(extra).toEqual({ sessionId: 'cs-x', cwd: a });
  // never a human-origin send — the reply can't land in humanPromptLedger.
  expect(extra.origin).toBeUndefined();

  const receipt = events(b, 'psess-y').at(-1);
  expect(receipt.notice).toBe('cross-project-reply-sent');
  expect(d.audits).toEqual([{ kind: 'epic_cross_project_reply', fields: expect.objectContaining({ epicId: 'psess-x', fromEpicId: 'psess-y', outcome: 'done' }) }]);
});

test('closed-tab case: sendPrompt carries sessionId and cwd so X resumes; unconfirmed send = event-only', async () => {
  const { a, b } = await setup({ xOverrides: { cwd: undefined } });
  const d = deps('unconfirmed');
  const r = await sendFeedbackReply(input(b), d);
  expect(r).toMatchObject({ ok: true, delivery: 'event-only' });
  expect(d.calls[0][2]).toEqual({ sessionId: 'cs-x', cwd: a });
  expect(events(a, 'psess-x').at(-1).notice).toBe('cross-project-reply');
  expect(events(b, 'psess-y').at(-1).notice).toBe('cross-project-reply-sent');
});

test('composeReplyPrompt frames the reply as untrusted, then message, then references', () => {
  const p = composeReplyPrompt({
    fromCwd: '/home/u/proj-b', fromEpicId: 'psess-y', fromGoalText: 'Fix relay', outcome: 'blocked',
    message: 'Need your API shape.', referencePaths: ['a.md', 'b.md'],
  });
  const lines = p.split('\n');
  expect(lines[0]).toMatch(/^REPLY FROM ANOTHER PROJECT: proj-b \(\/home\/u\/proj-b\), session psess-y/);
  expect(lines[0]).toContain('Fix relay');
  expect(lines[0]).toContain('blocked');
  expect(lines[1]).toMatch(/Nobody in this project wrote this\. An agent in that project did, and it may be wrong about this codebase — verify before acting\./);
  expect(p.indexOf('Need your API shape.')).toBeGreaterThan(p.indexOf('verify before acting'));
  expect(lines.slice(-2)).toEqual(['Reference: a.md', 'Reference: b.md']);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('validation: blank / oversized message, bad outcome, bad referencePaths', async () => {
  const { b } = await setup();
  const d = deps();
  for (const over of [
    { message: '   ' },
    { message: 'x'.repeat(MAX_BODY_CHARS + 1) },
    { outcome: 'maybe' },
    { referencePaths: 'a.md' },
    { referencePaths: [1] },
    { referencePaths: Array.from({ length: MAX_REFERENCES + 1 }, (_, i) => `p${i}`) },
  ]) {
    const r = await sendFeedbackReply(input(b, over), d);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  }
  expect(d.calls).toHaveLength(0);
});

test('no identity or no matching Epic → 403', async () => {
  const { b } = await setup();
  const d = deps();
  expect((await sendFeedbackReply(input(b, { originClaudeSessionId: undefined }), d)).status).toBe(403);
  expect((await sendFeedbackReply(input(b, { originClaudeSessionId: 'cs-nobody' }), d)).status).toBe(403);
  expect(d.calls).toHaveLength(0);
});

test('Y not a cross-project-feedback Epic with a replyTo → 400 naming feedback_open_session', async () => {
  const { b } = await setup({ ySource: { producer: 'new-epic-ui' } });
  const r = await sendFeedbackReply(input(b), deps());
  expect(r.status).toBe(400);
  expect(r.error).toContain('feedback_open_session');

  const { b: b2 } = await setup({ ySource: { producer: 'cross-project-feedback', replyTo: { cwd: '/x', epicId: 'e' } } });
  const r2 = await sendFeedbackReply(input(b2), deps());
  expect(r2.status).toBe(400);
  expect(r2.error).toContain('feedback_open_session');
});

test('toEpicId other than replyTo.epicId → 403 naming the only allowed Epic', async () => {
  const { b } = await setup();
  const d = deps();
  const r = await sendFeedbackReply(input(b, { toEpicId: 'psess-other' }), d);
  expect(r.status).toBe(403);
  expect(r.error).toContain('psess-x');
  expect(d.calls).toHaveLength(0);
});

test('replyTo.cwd outside allowed roots, not an SM project, or the replier itself → 400', async () => {
  const { a, b } = await setup();
  const src = (cwd) => ({ producer: 'cross-project-feedback', replyTo: { cwd, epicId: 'psess-x', claudeSessionId: 'cs-x' } });

  writeIndex(b, { 'psess-y': { id: 'psess-y', status: 'active', claudeSessionId: 'cs-y', source: src('/definitely/not/allowed') } });
  expect((await sendFeedbackReply(input(b), deps())).status).toBe(400);

  fs.rmSync(path.join(a, 'session-manager-operations'), { recursive: true, force: true });
  writeIndex(b, { 'psess-y': { id: 'psess-y', status: 'active', claudeSessionId: 'cs-y', source: src(a) } });
  expect((await sendFeedbackReply(input(b), deps())).status).toBe(400);

  writeIndex(b, { 'psess-y': { id: 'psess-y', status: 'active', claudeSessionId: 'cs-y', source: src(b) } });
  expect((await sendFeedbackReply(input(b), deps())).status).toBe(400);
});

test('X completed with openFallback disabled → 409 fallbackNeeded; nothing sent, no receipt', async () => {
  const { a, b } = await setup({ xOverrides: { status: 'completed' } });
  const d = deps('sent', { openFallback: null });
  const r = await sendFeedbackReply(input(b), d);
  expect(r).toMatchObject({ ok: false, status: 409, fallbackNeeded: true });
  expect(d.calls).toHaveLength(0);
  expect(events(a, 'psess-x')).toHaveLength(1);
  expect(events(b, 'psess-y')).toHaveLength(1);
});

test('X missing, or claudeSessionId mismatch, with openFallback disabled → 409', async () => {
  const { b } = await setup({ xOverrides: { claudeSessionId: 'cs-new' } });
  expect((await sendFeedbackReply(input(b), deps('sent', { openFallback: null }))).status).toBe(409);
  const { a, b: b2 } = await setup();
  writeIndex(a, {});
  expect((await sendFeedbackReply(input(b2), deps('sent', { openFallback: null }))).status).toBe(409);
});

test('a refused send goes to an injected openFallback with the original request', async () => {
  const { b } = await setup();
  const seen = [];
  const d = deps('refused', { openFallback: async (args) => { seen.push(args); return { ok: true, epicId: 'psess-f', toCwd: args.toCwd }; } });
  const r = await sendFeedbackReply(input(b), d);
  expect(r).toMatchObject({ ok: true, delivery: 'fallback', fallbackEpicId: 'psess-f', toEpicId: 'psess-x' });
  expect(seen[0].reason).toMatch(/^send-refused/);
  expect(seen[0].toEpicId).toBe('psess-x');
  expect(seen[0].original).toEqual({
    title: 'Relay drops a frame',
    proposal: expect.objectContaining({ motivation: 'Phones lose a frame' }),
    referencePaths: ['docs/original-spec.md'],
  });
  expect(events(b, 'psess-y').at(-1).text).toMatch(/fell back to a new proposed session psess-f in /);
});

// ---------------------------------------------------------------------------
// Default fallback — a new PROPOSED Epic in the asking project
// ---------------------------------------------------------------------------

function fallbackEpics(a) {
  return Object.values(readActiveIndex(a).sessions)
    .filter((s) => s.source && s.source.replyOf);
}

function expectFallbackEpic(a, b, reason) {
  const minted = fallbackEpics(a);
  expect(minted).toHaveLength(1);
  const f = minted[0];
  expect(f.status).toBe('proposed');
  expect(f.tag).toBe('discussion');
  expect(f.agentType).toBe('architect');
  expect(f.source).toMatchObject({
    producer: 'cross-project-feedback',
    fromCwd: b,
    fromEpicId: 'psess-y',
    replyOf: { cwd: a, epicId: 'psess-x' },
  });
  expect(f.source.autoApprove).toBeUndefined();
  expect(f.goalText).toBe(`Reply from ${path.basename(b)}: Relay drops a frame`);
  const p = f.openingPrompt;
  expect(p).toContain('Ask B something');
  expect(p).toContain('psess-x');
  expect(p).toContain(reason);
  expect(p).toContain('Relay drops a frame');
  expect(p).toContain('Phones lose a frame');
  expect(p).toContain('First frame arrives');
  expect(p).toContain('Fixed in commit abc123.');
  expect(p).toContain('done');
  expect(p).toContain('Reference: docs/original-spec.md');
  expect(p).toContain('Reference: src/relay.cjs');
  return f;
}

test('archived X: the reply opens a proposed Epic in A linking X, with X goal read from the archive', async () => {
  const { a, b } = await setup();
  writeIndex(a, {});
  fs.writeFileSync(opsPath(a, 'prompt-sessions', 'psess-x.json'), JSON.stringify({
    session: { id: 'psess-x', status: 'completed', goalText: 'Ask B something' },
    events: [],
    archivedAt: '2026-01-02T00:00:00.000Z',
  }));
  const d = deps('sent');
  const r = await sendFeedbackReply(input(b), d);
  expect(r).toMatchObject({ ok: true, delivery: 'fallback', reason: 'missing', receiptOnReplyingEpic: true });
  expect(d.calls).toHaveLength(0);
  const f = expectFallbackEpic(a, b, 'missing');
  expect(r.fallbackEpicId).toBe(f.id);
  expect(events(b, 'psess-y').at(-1)).toMatchObject({ notice: 'cross-project-reply-sent' });
  expect(events(b, 'psess-y').at(-1).text).toContain(f.id);
});

test('completed X: proposed Epic in A, receipt on Y and a best-effort receipt on X', async () => {
  const { a, b } = await setup({ xOverrides: { status: 'completed' } });
  const r = await sendFeedbackReply(input(b), deps('sent'));
  expect(r).toMatchObject({ ok: true, delivery: 'fallback', reason: 'not-active' });
  const f = expectFallbackEpic(a, b, 'not-active');
  expect(events(a, 'psess-x').at(-1).text).toContain(f.id);
});

test('refused send: proposed Epic in A carrying both sets of reference paths', async () => {
  const { a, b } = await setup();
  const r = await sendFeedbackReply(input(b, { referencePaths: ['src/relay.cjs', 'docs/original-spec.md'] }), deps('refused'));
  expect(r).toMatchObject({ ok: true, delivery: 'fallback' });
  expect(r.reason).toMatch(/^send-refused/);
  const f = expectFallbackEpic(a, b, 'send-refused');
  expect(f.openingPrompt.split('Reference: docs/original-spec.md')).toHaveLength(2);
});

test('fallbacks count toward the per-thread cap', async () => {
  const { a, b } = await setup({ xOverrides: { status: 'completed' } });
  for (let i = 0; i < MAX_REPLIES_PER_THREAD; i++) {
    expect((await sendFeedbackReply(input(b), deps())).ok).toBe(true);
  }
  expect((await sendFeedbackReply(input(b), deps())).status).toBe(429);
  expect(fallbackEpics(a)).toHaveLength(MAX_REPLIES_PER_THREAD);
});

// ---------------------------------------------------------------------------
// Receipt durability — the receipt on Y is the cap's only record
// ---------------------------------------------------------------------------

/** The real appender, except receipts on Y come back { ok: false } — what
 *  appendResponseEventWithReason returns for a failed read/write. */
function failingReceiptAppender() {
  const real = require('../../../promptSessionEvents.cjs').appendResponseEventWithReason;
  return async (cwd, epicId, text, meta) => (meta && meta.notice === 'cross-project-reply-sent'
    ? { ok: false, reason: 'error' }
    : real(cwd, epicId, text, meta));
}

test('a receipt that did not land is reported, never claimed (delivered and fallback paths)', async () => {
  const { b } = await setup();
  const delivered = await sendFeedbackReply(input(b), deps('sent', { appendEvent: failingReceiptAppender() }));
  expect(delivered).toMatchObject({ ok: true, delivery: 'delivered', receiptOnReplyingEpic: false, receiptError: 'error' });
  expect(events(b, 'psess-y')).toHaveLength(1);

  const { a: a2, b: b2 } = await setup({ xOverrides: { status: 'completed' } });
  const fell = await sendFeedbackReply(input(b2), deps('sent', { appendEvent: failingReceiptAppender() }));
  expect(fell).toMatchObject({ ok: true, delivery: 'fallback', receiptOnReplyingEpic: false, receiptError: 'error' });
  expect(fallbackEpics(a2)).toHaveLength(1);
  expect(events(b2, 'psess-y')).toHaveLength(1);

  const { b: b3 } = await setup();
  expect(await sendFeedbackReply(input(b3), deps('sent'))).toMatchObject({ ok: true, receiptOnReplyingEpic: true });
  expect(events(b3, 'psess-y').at(-1).notice).toBe('cross-project-reply-sent');
});

// ---------------------------------------------------------------------------
// Cap
// ---------------------------------------------------------------------------

test('cap: the 4th reply is refused with 429', async () => {
  const { b } = await setup();
  const d = deps();
  for (let i = 0; i < MAX_REPLIES_PER_THREAD; i++) {
    expect((await sendFeedbackReply(input(b), d)).ok).toBe(true);
  }
  const r = await sendFeedbackReply(input(b), d);
  expect(r.status).toBe(429);
  expect(MAX_REPLIES_PER_THREAD).toBe(3);
});

test('cap: 5 concurrent calls deliver exactly 3', async () => {
  const { a, b } = await setup();
  const d = deps();
  const results = await Promise.all(Array.from({ length: 5 }, () => sendFeedbackReply(input(b), d)));
  expect(results.filter((r) => r.ok)).toHaveLength(3);
  expect(results.filter((r) => r.status === 429)).toHaveLength(2);
  expect(d.calls).toHaveLength(3);
  expect(events(a, 'psess-x').filter((e) => e.notice === 'cross-project-reply')).toHaveLength(3);
  expect(events(b, 'psess-y').filter((e) => e.notice === 'cross-project-reply-sent')).toHaveLength(3);
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

function fakeRes() {
  const res = { status: null, body: null };
  res.writeHead = (s) => { res.status = s; };
  res.end = (b) => { res.body = JSON.parse(b); };
  return res;
}

test('route: POST /admin/feedback/reply registered; invalid JSON → 400', async () => {
  const routes = [];
  registerAdminRoute({ registerRoute: (m, u, h) => routes.push({ m, u, h }) });
  expect(routes.map((r) => `${r.m} ${r.u}`)).toEqual(['POST /admin/feedback/reply']);
  const res = fakeRes();
  await routes[0].h(Readable.from([Buffer.from('{not json')]), res);
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ ok: false, error: 'invalid JSON body' });
});

test('route: a refusal maps to its status', async () => {
  const routes = [];
  registerAdminRoute({ registerRoute: (m, u, h) => routes.push({ m, u, h }) });
  const res = fakeRes();
  await routes[0].h(Readable.from([Buffer.from(JSON.stringify({ message: 'x', outcome: 'done' }))]), res);
  expect(res.status).toBe(403);
  expect(res.body.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// Legacy request Epics (minted before reply threads: no replyTo, no replyOf)
// ---------------------------------------------------------------------------

async function setupLegacy(opts = {}) {
  const legacySource = (a) => ({
    producer: 'cross-project-feedback',
    fromCwd: a,
    fromEpicId: 'psess-x',
    proposal: { motivation: 'Phones lose a frame', acceptanceCriteria: ['First frame arrives'], plan: [], outOfScope: [] },
  });
  // setup() creates `a` itself, so rewrite Y's source once it exists.
  const { a, b } = await setup({ xOverrides: opts.xOverrides });
  const file = opsPath(b, 'prompt-sessions', 'active-index.json');
  const idx = JSON.parse(fs.readFileSync(file, 'utf8'));
  idx.sessions['psess-y'].source = legacySource(a);
  fs.writeFileSync(file, JSON.stringify(idx));
  return { a, b };
}

test('legacy request Epic with an active X → delivered on thread "legacy", prompt sent with X\'s own session', async () => {
  const { a, b } = await setupLegacy({ xOverrides: { claudeSessionId: 'cs-x-own' } });
  const d = deps('sent');
  const r = await sendFeedbackReply(input(b), d);
  expect(r).toMatchObject({ ok: true, delivery: 'delivered', thread: 'legacy', toEpicId: 'psess-x' });
  expect(d.calls).toHaveLength(1);
  expect(d.calls[0][0]).toBe('psess-x');
  expect(d.calls[0][2]).toEqual({ sessionId: 'cs-x-own', cwd: a });
  expect(events(a, 'psess-x').at(-1).notice).toBe('cross-project-reply');
  expect(d.audits[0].fields).toMatchObject({ thread: 'legacy', epicId: 'psess-x' });
});

test('legacy request Epic with X missing → fallback with toEpicId = fromEpicId, thread "legacy"', async () => {
  const { a, b } = await setupLegacy();
  writeIndex(a, {});
  const seen = [];
  const d = deps('sent', { openFallback: async (args) => { seen.push(args); return { ok: true, epicId: 'psess-f', toCwd: args.toCwd }; } });
  const r = await sendFeedbackReply(input(b), d);
  expect(r).toMatchObject({ ok: true, delivery: 'fallback', reason: 'missing', thread: 'legacy' });
  expect(seen[0]).toMatchObject({ reason: 'missing', toEpicId: 'psess-x', toCwd: a });
  expect(d.calls).toHaveLength(0);
});

test('legacy request Epic: X without a claudeSessionId → session-mismatch fallback', async () => {
  const { b } = await setupLegacy({ xOverrides: { claudeSessionId: '' } });
  const r = await sendFeedbackReply(input(b), deps('sent', { openFallback: null }));
  expect(r).toMatchObject({ status: 409, reason: 'session-mismatch' });
});

test('legacy request Epic: toEpicId other than fromEpicId → 403', async () => {
  const { b } = await setupLegacy();
  const d = deps();
  const r = await sendFeedbackReply(input(b, { toEpicId: 'psess-other' }), d);
  expect(r.status).toBe(403);
  expect(r.error).toContain('psess-x');
  expect(d.calls).toHaveLength(0);
});

test('reply-fallback Epic (source.replyOf) → 400 saying it is itself an undelivered reply', async () => {
  const { a, b } = await setup({ ySource: undefined });
  const file = opsPath(b, 'prompt-sessions', 'active-index.json');
  const idx = JSON.parse(fs.readFileSync(file, 'utf8'));
  idx.sessions['psess-y'].source = { producer: 'cross-project-feedback', fromCwd: a, fromEpicId: 'psess-x', replyOf: { cwd: a, epicId: 'psess-z' } };
  fs.writeFileSync(file, JSON.stringify(idx));
  const d = deps();
  const r = await sendFeedbackReply(input(b), d);
  expect(r.status).toBe(400);
  expect(r.error).toMatch(/itself a reply that could not be delivered/);
  expect(r.error).toContain('feedback_open_session');
  expect(d.calls).toHaveLength(0);
});

test('cross-project request with no fromEpicId → 400 naming fromCwd and feedback_open_session', async () => {
  const { b } = await setup({ ySource: { producer: 'cross-project-feedback', fromCwd: '/home/u/proj-a' } });
  const r = await sendFeedbackReply(input(b), deps());
  expect(r.status).toBe(400);
  expect(r.error).toMatch(/sending session was not identified/);
  expect(r.error).toContain('/home/u/proj-a');
  expect(r.error).toContain('feedback_open_session');
});

test('incomplete replyTo object (even with fromEpicId) → 400 as before', async () => {
  const { a, b } = await setup({ ySource: undefined });
  const file = opsPath(b, 'prompt-sessions', 'active-index.json');
  const idx = JSON.parse(fs.readFileSync(file, 'utf8'));
  idx.sessions['psess-y'].source = { producer: 'cross-project-feedback', fromCwd: a, fromEpicId: 'psess-x', replyTo: { cwd: a, epicId: 'psess-x' } };
  fs.writeFileSync(file, JSON.stringify(idx));
  const r = await sendFeedbackReply(input(b), deps());
  expect(r.status).toBe(400);
  expect(r.error).toMatch(/not answering a cross-project request with a reply thread/);
});
