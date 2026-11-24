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
  fs.writeFileSync(path.join(cwd, '.claude', 'agents', 'architect.md'), '---\nname: architect\nmodel: sonnet\n---\nFixture persona.\n');
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
    expect((await sendFeedbackReply(input(b, { message: `reply ${i}` }), deps())).ok).toBe(true);
  }
  expect((await sendFeedbackReply(input(b, { message: 'one more' }), deps())).status).toBe(429);
  // One OPEN fallback Epic per thread: later fallbacks reuse it (replyFallbackReuse.test.cjs).
  expect(fallbackEpics(a)).toHaveLength(1);
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
    expect((await sendFeedbackReply(input(b, { message: `reply ${i}` }), d)).ok).toBe(true);
  }
  const r = await sendFeedbackReply(input(b, { message: 'one more' }), d);
  expect(r.status).toBe(429);
  expect(MAX_REPLIES_PER_THREAD).toBe(3);
});

test('cap: 5 concurrent calls deliver exactly 3', async () => {
  const { a, b } = await setup();
  const d = deps();
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => sendFeedbackReply(input(b, { message: `reply ${i}` }), d)));
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

// ---------------------------------------------------------------------------
// replyTo.mode 'event' — the asker wants the reply as data, never a chat prompt
// ---------------------------------------------------------------------------

/** Re-stamp Y's source with an event-mode replyTo (epicId may be null). */
function setEventMode(a, b, { epicId = 'psess-x', claudeSessionId = 'cs-x', externalRef } = {}) {
  const idx = readActiveIndex(b);
  const y = idx.sessions['psess-y'];
  y.source = {
    producer: 'cross-project-feedback',
    fromCwd: a,
    ...(epicId ? { fromEpicId: epicId } : {}),
    ...(externalRef ? { externalRef } : {}),
    replyTo: { cwd: a, epicId, claudeSessionId: epicId ? claudeSessionId : null, mode: 'event' },
    proposal: {},
  };
  writeIndex(b, { 'psess-y': y });
}

const failFallback = async () => { throw new Error('fallback must not open in event mode'); };

test('event mode, asker active: event on X, no prompt, no fallback, event-only receipt + rich audit', async () => {
  const { a, b } = await setup();
  setEventMode(a, b, { externalRef: 'portfolio:action-42' });
  const d = deps('sent', { openFallback: failFallback });
  const long = 'y'.repeat(2500);
  const refs = Array.from({ length: 10 }, (_, i) => `r${i}.md`);
  const r = await sendFeedbackReply(input(b, { message: long, referencePaths: refs }), d);
  expect(r).toMatchObject({ ok: true, delivery: 'event-only', reason: 'asker-requested-event', toEpicId: 'psess-x', receiptOnReplyingEpic: true });
  expect(d.calls).toHaveLength(0);
  expect(events(a, 'psess-x').at(-1).notice).toBe('cross-project-reply');
  expect(events(b, 'psess-y').at(-1).notice).toBe('cross-project-reply-sent');
  expect(d.audits).toHaveLength(1);
  const f = d.audits[0].fields;
  expect(d.audits[0].kind).toBe('epic_cross_project_reply');
  expect(f).toMatchObject({ mode: 'event', externalRef: 'portfolio:action-42', delivery: 'event-only', outcome: 'done', fromEpicId: 'psess-y', epicId: 'psess-x' });
  expect(f.message).toHaveLength(2000);
  expect(f.referencePaths).toEqual(refs);
});

test('event mode, asker gone (missing / completed): no event, no prompt, no fallback, still ok', async () => {
  for (const variant of ['missing', 'completed']) {
    const { a, b } = await setup(variant === 'completed' ? { xOverrides: { status: 'completed' } } : {});
    setEventMode(a, b);
    if (variant === 'missing') writeIndex(a, {});
    const before = events(a, 'psess-x').length;
    const d = deps('sent', { openFallback: failFallback });
    const r = await sendFeedbackReply(input(b), d);
    expect(r).toMatchObject({ ok: true, delivery: 'event-only', reason: 'asker-requested-event' });
    expect(d.calls).toHaveLength(0);
    expect(events(a, 'psess-x')).toHaveLength(before);
    expect(Object.values(readActiveIndex(a).sessions).filter((s) => s.source && s.source.replyOf)).toHaveLength(0);
    expect(events(b, 'psess-y').at(-1).notice).toBe('cross-project-reply-sent');
    expect(d.audits[0].fields).toMatchObject({ mode: 'event' });
    expect(d.audits[0].fields).not.toHaveProperty('externalRef');
  }
});

test('event mode, asker without an Epic (cwd-only replyTo): ok event-only, nothing appended in A', async () => {
  const { a, b } = await setup();
  setEventMode(a, b, { epicId: null, externalRef: 'ext-1' });
  const d = deps('sent', { openFallback: failFallback });
  const r = await sendFeedbackReply(input(b), d);
  expect(r).toMatchObject({ ok: true, delivery: 'event-only', reason: 'asker-requested-event', toEpicId: null });
  expect(d.calls).toHaveLength(0);
  expect(events(a, 'psess-x')).toHaveLength(1);
  expect(d.audits[0].fields).toMatchObject({ mode: 'event', externalRef: 'ext-1', epicId: null, message: 'Fixed in commit abc123.', referencePaths: ['src/relay.cjs'] });
});

test('event mode: the per-thread reply limit still applies', async () => {
  const { a, b } = await setup();
  setEventMode(a, b, { epicId: null });
  const d = deps('sent', { openFallback: failFallback });
  for (let i = 0; i < MAX_REPLIES_PER_THREAD; i++) {
    expect((await sendFeedbackReply(input(b, { message: `reply ${i}` }), d)).ok).toBe(true);
  }
  const r = await sendFeedbackReply(input(b, { message: 'one more' }), d);
  expect(r).toMatchObject({ ok: false, status: 429 });
  expect(d.calls).toHaveLength(0);
});

test('default (no mode) path is unchanged: prompt sent, audit row has no event-mode fields', async () => {
  const { b } = await setup();
  const d = deps('sent');
  const r = await sendFeedbackReply(input(b), d);
  expect(r).toMatchObject({ ok: true, delivery: 'delivered' });
  expect(r).not.toHaveProperty('reason');
  expect(d.calls).toHaveLength(1);
  const f = d.audits[0].fields;
  for (const k of ['mode', 'externalRef', 'message', 'referencePaths']) expect(f).not.toHaveProperty(k);
});

// ---------------------------------------------------------------------------
// Identical retries and the reused fallback Epic
// ---------------------------------------------------------------------------

const sha256 = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex');
const receipts = (cwd, id) => events(cwd, id).filter((e) => e.notice === 'cross-project-reply-sent');

test('the same reply delivered twice opens one Epic and writes one receipt (cap not consumed)', async () => {
  const { a, b } = await setup();
  writeIndex(a, {});
  const d = deps('sent');
  const first = await sendFeedbackReply(input(b), d);
  expect(first).toMatchObject({ ok: true, delivery: 'fallback', reason: 'missing', repliesUsed: 1 });
  expect(receipts(b, 'psess-y')).toHaveLength(1);
  expect(receipts(b, 'psess-y')[0].reply.hash).toBe(sha256('done\nFixed in commit abc123.'));

  const again = await sendFeedbackReply(input(b), d);
  expect(again).toMatchObject({
    ok: true,
    alreadyDelivered: true,
    delivery: 'fallback',
    reason: 'missing',
    toEpicId: 'psess-x',
    fallbackEpicId: first.fallbackEpicId,
    repliesUsed: 1,
    repliesLeft: MAX_REPLIES_PER_THREAD - 1,
  });
  expect(fallbackEpics(a)).toHaveLength(1);
  expect(receipts(b, 'psess-y')).toHaveLength(1);
  expect(d.calls).toHaveLength(0);
});

test('an identical retry of a delivered reply is not sent again; every receipt carries reply.hash', async () => {
  const { a, b } = await setup();
  const d = deps('sent');
  const first = await sendFeedbackReply(input(b), d);
  const again = await sendFeedbackReply(input(b), d);
  expect(again).toMatchObject({ ok: true, alreadyDelivered: true, delivery: 'delivered', toEpicId: 'psess-x', repliesUsed: 1 });
  expect(first.alreadyDelivered).toBeUndefined();
  expect(d.calls).toHaveLength(1);
  expect(events(a, 'psess-x').filter((e) => e.notice === 'cross-project-reply')).toHaveLength(1);
  // A different reply after it still goes out, and its hash differs.
  const other = await sendFeedbackReply(input(b, { outcome: 'blocked', message: 'Actually blocked.' }), d);
  expect(other).toMatchObject({ ok: true, delivery: 'delivered', repliesUsed: 2 });
  const hs = receipts(b, 'psess-y').map((e) => e.reply.hash);
  expect(hs).toEqual([sha256('done\nFixed in commit abc123.'), sha256('blocked\nActually blocked.')]);
});

test('two different replies (blocked, then done) with the asking Epic missing open one Epic and both land in it', async () => {
  const { a, b } = await setup();
  writeIndex(a, {});
  const d = deps('sent');
  const first = await sendFeedbackReply(input(b, { outcome: 'blocked', message: 'Blocked on your API shape.' }), d);
  expect(first).toMatchObject({ ok: true, delivery: 'fallback' });
  expect(first.reused).toBeUndefined();
  const second = await sendFeedbackReply(input(b, { outcome: 'done', message: 'Unblocked and shipped.' }), d);
  expect(second).toMatchObject({ ok: true, delivery: 'fallback', fallbackEpicId: first.fallbackEpicId, reused: true });

  const minted = fallbackEpics(a);
  expect(minted).toHaveLength(1);
  const f = minted[0];
  expect(f.status).toBe('proposed');
  expect(f.openingPrompt).toContain('Blocked on your API shape.');
  const replyEv = events(a, f.id).filter((e) => e.notice === 'cross-project-reply');
  expect(replyEv).toHaveLength(1);
  expect(replyEv[0].text).toContain('Unblocked and shipped.');
  expect(replyEv[0].reply).toMatchObject({ fromEpicId: 'psess-y', outcome: 'done' });
  // A proposed Epic has no chat to prompt.
  expect(d.calls).toHaveLength(0);
  expect(receipts(b, 'psess-y')).toHaveLength(2);
  expect(receipts(b, 'psess-y')[1].reply).toMatchObject({ delivery: 'fallback', reused: true, fallbackEpicId: f.id });
});

test('a reused ACTIVE fallback Epic gets the reply as event + prompt, like a delivered reply', async () => {
  const { a, b } = await setup();
  writeIndex(a, {});
  const d = deps('sent');
  const first = await sendFeedbackReply(input(b, { outcome: 'blocked', message: 'Blocked.' }), d);
  const idxFile = opsPath(a, 'prompt-sessions', 'active-index.json');
  const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
  Object.assign(idx.sessions[first.fallbackEpicId], { status: 'active', claudeSessionId: 'cs-f' });
  fs.writeFileSync(idxFile, JSON.stringify(idx));

  const second = await sendFeedbackReply(input(b, { message: 'Done now.' }), d);
  expect(second).toMatchObject({ ok: true, delivery: 'fallback', fallbackEpicId: first.fallbackEpicId, reused: true });
  expect(d.calls).toHaveLength(1);
  const [tabId, prompt, extra] = d.calls[0];
  expect(tabId).toBe(first.fallbackEpicId);
  expect(prompt).toContain('Done now.');
  expect(extra).toEqual({ sessionId: 'cs-f', cwd: expect.any(String) });
  expect(events(a, first.fallbackEpicId).at(-1)).toMatchObject({ notice: 'cross-project-reply', text: prompt });
});

// ---------------------------------------------------------------------------
// Scheduled replies (deliverWhen) — held in the pending-reply ledger
// ---------------------------------------------------------------------------

async function withSchedulerHome(fn) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-xreply-home-'));
  tmpDirs.push(home);
  const prev = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.SM_SCHEDULER_HOME;
    else process.env.SM_SCHEDULER_HOME = prev;
  }
}

const readLedger = (home) => {
  const file = path.join(home, 'pending-replies.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).entries : [];
};

test('deliverWhen: a scheduled reply writes one ledger entry and sends no prompt', async () => {
  await withSchedulerHome(async (home) => {
    const { a, b } = await setup();
    const d = deps('sent');
    const before = events(a, 'psess-x').length;
    const r = await sendFeedbackReply(input(b, {
      message: 'Live in v{version}.', deliverWhen: { appVersionAbove: '0.141.0' },
    }), d);
    expect(r).toEqual({
      ok: true, delivery: 'scheduled', deliverWhen: { appVersionAbove: '0.141.0' },
      repliesUsed: 1, repliesLeft: MAX_REPLIES_PER_THREAD - 1,
    });
    expect(d.calls).toHaveLength(0);
    expect(events(a, 'psess-x')).toHaveLength(before);
    expect(events(b, 'psess-y').some((e) => e.notice === 'cross-project-reply-sent')).toBe(false);

    const ledger = readLedger(home);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      replierCwd: b,
      yId: 'psess-y',
      goalText: 'Relay drops a frame',
      thread: { cwd: a, epicId: 'psess-x', claudeSessionId: 'cs-x', legacy: false, mode: null },
      targetCwd: a,
      outcome: 'done',
      message: 'Live in v{version}.',
      referencePaths: ['src/relay.cjs'],
      appVersionAbove: '0.141.0',
      deliveredAt: null,
    });
    expect(d.audits).toEqual([{
      kind: 'cross-project-reply-scheduled',
      fields: expect.objectContaining({ cwd: a, epicId: 'psess-x', fromEpicId: 'psess-y', appVersionAbove: '0.141.0' }),
    }]);
  });
});

test('deliverWhen: the per-thread cap counts pending ledger entries', async () => {
  await withSchedulerHome(async (home) => {
    const { b } = await setup();
    const d = deps('sent');
    // one live reply (a receipt) + pending entries fill the cap together.
    expect((await sendFeedbackReply(input(b, { message: 'live one' }), d)).ok).toBe(true);
    for (let i = 1; i < MAX_REPLIES_PER_THREAD; i++) {
      const r = await sendFeedbackReply(input(b, { message: `scheduled ${i}`, deliverWhen: { appVersionAbove: '1.0.0' } }), d);
      expect(r).toMatchObject({ ok: true, delivery: 'scheduled', repliesUsed: i + 1 });
    }
    expect(readLedger(home)).toHaveLength(MAX_REPLIES_PER_THREAD - 1);
    const over = await sendFeedbackReply(input(b, { message: 'one too many', deliverWhen: { appVersionAbove: '1.0.0' } }), d);
    expect(over.status).toBe(429);
    // a live reply is refused too: the pending entries hold its slots.
    const live = await sendFeedbackReply(input(b, { message: 'live two' }), d);
    expect(live.status).toBe(429);
    expect(readLedger(home)).toHaveLength(MAX_REPLIES_PER_THREAD - 1);
    expect(d.calls).toHaveLength(1);
  });
});

test('deliverWhen: any shape but { appVersionAbove: "x.y.z" } is refused with 400', async () => {
  await withSchedulerHome(async (home) => {
    const { b } = await setup();
    const d = deps();
    for (const deliverWhen of [
      'later', 5, [], {}, { appVersionAbove: '1.2' }, { appVersionAbove: 'v1.2.3' },
      { appVersionAbove: 123 }, { appVersionAbove: '1.2.3', extra: true }, { version: '1.2.3' },
    ]) {
      const r = await sendFeedbackReply(input(b, { deliverWhen }), d);
      expect(r.ok).toBe(false);
      expect(r.status).toBe(400);
    }
    expect(d.calls).toHaveLength(0);
    expect(readLedger(home)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deliverDueReplies — the hourly pass that sends held replies once due
// ---------------------------------------------------------------------------

const { deliverDueReplies } = require('../crossProjectReply.cjs');

test('deliverDueReplies: a due entry is delivered with {version} filled in, audited and marked', async () => {
  await withSchedulerHome(async (home) => {
    const { a, b } = await setup();
    const d = deps('sent');
    await sendFeedbackReply(input(b, { message: 'Live in v{version} ({version}).', deliverWhen: { appVersionAbove: '0.141.0' } }), d);
    d.audits.length = 0;
    const r = await deliverDueReplies({ appVersion: '0.142.0' }, d);
    expect(r).toMatchObject({ due: 1, delivered: 1, failed: 0 });
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0][1]).toContain('Live in v0.142.0 (0.142.0).');
    expect(d.calls[0][1]).not.toContain('{version}');
    expect(events(a, 'psess-x').at(-1)).toMatchObject({ notice: 'cross-project-reply' });
    expect(events(b, 'psess-y').at(-1)).toMatchObject({ notice: 'cross-project-reply-sent' });
    expect(d.audits.map((x) => x.kind)).toContain('cross-project-reply-delivered-scheduled');
    const [entry] = readLedger(home);
    expect(entry).toMatchObject({ deliveredVersion: '0.142.0', lastError: null });
    expect(entry.deliveredAt).toEqual(expect.any(String));
    // A second pass finds nothing due.
    expect(await deliverDueReplies({ appVersion: '0.142.0' }, d)).toMatchObject({ due: 0, delivered: 0 });
    expect(d.calls).toHaveLength(1);
  });
});

test('deliverDueReplies: a not-due entry (equal version) is skipped and stays pending', async () => {
  await withSchedulerHome(async (home) => {
    const { b } = await setup();
    const d = deps('sent');
    await sendFeedbackReply(input(b, { message: 'Live in v{version}.', deliverWhen: { appVersionAbove: '0.141.0' } }), d);
    const r = await deliverDueReplies({ appVersion: '0.141.0' }, d);
    expect(r).toMatchObject({ due: 0, delivered: 0, failed: 0 });
    expect(d.calls).toHaveLength(0);
    expect(readLedger(home)[0].deliveredAt).toBeNull();
  });
});

test('deliverDueReplies: a closed scheduling Epic still delivers; no receipt is written on it', async () => {
  await withSchedulerHome(async (home) => {
    const { a, b } = await setup();
    const d = deps('sent');
    await sendFeedbackReply(input(b, { message: 'Live in v{version}.', deliverWhen: { appVersionAbove: '0.141.0' } }), d);
    // Y closes: it leaves B's active index.
    writeIndex(b, {});
    const appended = [];
    const realAppend = require('../../../promptSessionEvents.cjs').appendResponseEventWithReason;
    d.appendEvent = async (cwd, epicId, text, meta) => {
      appended.push({ cwd, epicId, notice: meta && meta.notice });
      return realAppend(cwd, epicId, text, meta);
    };
    const r = await deliverDueReplies({ appVersion: '0.142.0' }, d);
    expect(r).toMatchObject({ due: 1, delivered: 1, failed: 0 });
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0][1]).toContain('Live in v0.142.0.');
    expect(events(a, 'psess-x').at(-1)).toMatchObject({ notice: 'cross-project-reply' });
    expect(appended.some((x) => x.epicId === 'psess-y')).toBe(false);
    expect(readLedger(home)[0].deliveredVersion).toBe('0.142.0');
  });
});

test('deliverDueReplies: a failing delivery stays pending with lastError while the next one goes', async () => {
  const { a, b } = await setup();
  const entry = (id, message) => ({
    id, replierCwd: b, yId: 'psess-y', goalText: 'Relay drops a frame',
    thread: { cwd: a, epicId: 'psess-x', claudeSessionId: 'cs-x', legacy: false, mode: null },
    targetCwd: a, outcome: 'done', message, referencePaths: [], appVersionAbove: '0.141.0',
    deliveredAt: null, deliveredVersion: null, lastError: null,
  });
  const marks = [];
  let sends = 0;
  const d = deps('sent', {
    listDueReplies: () => [entry('e1', 'first {version}'), entry('e2', 'second {version}'), entry('e3', 'third {version}')],
    markReplyDelivered: (id, arg) => { marks.push({ id, ...arg }); return {}; },
  });
  d.sendPrompt = async (...args) => {
    sends += 1;
    if (sends === 1) throw new Error('boom');
    d.calls.push(args);
    return { disposition: 'sent' };
  };
  // e1: send throws → event-only (still ok). Force a real failure on e2 instead:
  const realAppend = require('../../../promptSessionEvents.cjs').appendResponseEventWithReason;
  d.appendEvent = async (cwd, epicId, text, meta) => {
    if (text.includes('second 0.142.0')) throw new Error('disk full');
    return realAppend(cwd, epicId, text, meta);
  };
  const r = await deliverDueReplies({ appVersion: '0.142.0' }, d);
  expect(r).toMatchObject({ due: 3, delivered: 2, failed: 1 });
  const byId = Object.fromEntries(marks.map((m) => [m.id, m]));
  expect(byId.e2.result.ok).toBe(false);
  expect(byId.e2.result.error).toContain('disk full');
  expect(byId.e1.result.ok).not.toBe(false);
  expect(byId.e3.result.ok).not.toBe(false);
  expect(byId.e3.version).toBe('0.142.0');
  expect(d.calls.some((c) => c[1].includes('third 0.142.0'))).toBe(true);
});

test('deliverDueReplies: a not-ok result is recorded as lastError, never thrown', async () => {
  const { a, b } = await setup({ xOverrides: { status: 'closed' } });
  const marks = [];
  const d = deps('sent', {
    openFallback: null,
    listDueReplies: () => [{
      id: 'n1', replierCwd: b, yId: 'psess-y', goalText: 'g',
      thread: { cwd: a, epicId: 'psess-x', claudeSessionId: 'cs-x', legacy: false, mode: null },
      targetCwd: a, outcome: 'done', message: 'm', referencePaths: [], appVersionAbove: '0.1.0',
    }],
    markReplyDelivered: (id, arg) => { marks.push({ id, ...arg }); return {}; },
  });
  const r = await deliverDueReplies({ appVersion: '0.142.0' }, d);
  expect(r).toMatchObject({ due: 1, delivered: 0, failed: 1 });
  expect(marks[0].result).toMatchObject({ ok: false, fallbackNeeded: true });
});

test('deliverDueReplies: event mode, scheduling Epic closed — audit keeps externalRef, counts come from scheduling time', async () => {
  await withSchedulerHome(async (home) => {
    const { a, b } = await setup();
    setEventMode(a, b, { externalRef: 'portfolio:action-77' });
    const d = deps('sent', { openFallback: failFallback });
    // One live reply (a receipt), then the scheduled one: 2 used at scheduling time.
    expect((await sendFeedbackReply(input(b, { message: 'live first' }), d)).ok).toBe(true);
    const scheduled = await sendFeedbackReply(input(b, { message: 'Live in v{version}.', deliverWhen: { appVersionAbove: '0.141.0' } }), d);
    expect(scheduled).toMatchObject({ ok: true, delivery: 'scheduled', repliesUsed: 2 });
    const [stored] = readLedger(home);
    expect(stored.sentAtScheduling).toBe(2);
    expect(stored.ySource).toMatchObject({ externalRef: 'portfolio:action-77', replyTo: { mode: 'event' } });
    // Y closes: it leaves B's active index.
    writeIndex(b, {});
    d.audits.length = 0;
    const marks = [];
    const pr = require('../pendingReplies.cjs');
    d.markReplyDelivered = (id, arg) => { marks.push(arg); return pr.markReplyDelivered(id, arg); };
    const r = await deliverDueReplies({ appVersion: '0.142.0' }, d);
    expect(r).toMatchObject({ due: 1, delivered: 1, failed: 0 });
    expect(d.calls).toHaveLength(0);
    const replyAudit = d.audits.find((x) => x.kind === 'epic_cross_project_reply');
    expect(replyAudit.fields).toMatchObject({ mode: 'event', externalRef: 'portfolio:action-77', message: 'Live in v0.142.0.' });
    expect(marks[0].result).toMatchObject({ ok: true, delivery: 'event-only', repliesUsed: 2, repliesLeft: MAX_REPLIES_PER_THREAD - 2 });
  });
});

test('deliverDueReplies: a stored entry without ySource / sentAtScheduling still delivers for a closed Epic', async () => {
  const { a, b } = await setup();
  writeIndex(b, {});
  const marks = [];
  const d = deps('sent', {
    openFallback: failFallback,
    listDueReplies: () => [{
      id: 'old1', replierCwd: b, yId: 'psess-y', goalText: 'g',
      thread: { cwd: a, epicId: 'psess-x', claudeSessionId: 'cs-x', legacy: false, mode: 'event' },
      targetCwd: a, outcome: 'done', message: 'm', referencePaths: [], appVersionAbove: '0.1.0',
    }],
    markReplyDelivered: (id, arg) => { marks.push(arg); return {}; },
  });
  const r = await deliverDueReplies({ appVersion: '0.142.0' }, d);
  expect(r).toMatchObject({ due: 1, delivered: 1 });
  const replyAudit = d.audits.find((x) => x.kind === 'epic_cross_project_reply');
  expect(replyAudit.fields).not.toHaveProperty('externalRef');
  expect(marks[0].result).toMatchObject({ ok: true, repliesUsed: 1 });
});

// ---------------------------------------------------------------------------
// Scheduled replies: identical-retry dedupe, give-up, no overlapping passes
// ---------------------------------------------------------------------------

test('deliverWhen: an identical scheduled retry returns the held entry without a new entry or cap slot', async () => {
  await withSchedulerHome(async (home) => {
    const { b } = await setup();
    const d = deps('sent');
    const first = await sendFeedbackReply(input(b, { message: 'Live in v{version}.', deliverWhen: { appVersionAbove: '0.141.0' } }), d);
    expect(first).toMatchObject({ ok: true, delivery: 'scheduled', repliesUsed: 1 });
    const [held] = readLedger(home);
    const again = await sendFeedbackReply(input(b, { message: 'Live in v{version}.', deliverWhen: { appVersionAbove: '0.141.0' } }), d);
    expect(again).toMatchObject({
      ok: true, delivery: 'scheduled', alreadyScheduled: true, id: held.id,
      deliverWhen: { appVersionAbove: '0.141.0' },
      repliesUsed: 1, repliesLeft: MAX_REPLIES_PER_THREAD - 1,
    });
    expect(readLedger(home)).toHaveLength(1);
    expect(d.audits.filter((x) => x.kind === 'cross-project-reply-scheduled')).toHaveLength(1);
    // A different message is a new reply and takes a new slot.
    const other = await sendFeedbackReply(input(b, { message: 'Other.', deliverWhen: { appVersionAbove: '0.141.0' } }), d);
    expect(other).toMatchObject({ ok: true, delivery: 'scheduled', repliesUsed: 2 });
    expect(other.alreadyScheduled).toBeUndefined();
    expect(readLedger(home)).toHaveLength(2);
  });
});

test('deliverDueReplies: after 24 failed passes the entry gives up, is audited with its last error, and is never retried', async () => {
  await withSchedulerHome(async (home) => {
    const { b } = await setup({ xOverrides: { status: 'closed' } });
    const d = deps('sent', { openFallback: null });
    await sendFeedbackReply(input(b, { message: 'Live in v{version}.', deliverWhen: { appVersionAbove: '0.141.0' } }), d);
    d.audits.length = 0;
    for (let i = 1; i <= 24; i++) {
      const r = await deliverDueReplies({ appVersion: '0.142.0' }, d);
      expect(r).toMatchObject({ due: 1, delivered: 0, failed: 1 });
      const gaveUp = d.audits.filter((x) => x.kind === 'cross-project-reply-scheduled-gave-up');
      expect(gaveUp).toHaveLength(i === 24 ? 1 : 0);
    }
    const [entry] = readLedger(home);
    expect(entry.attempts).toBe(24);
    expect(entry.gaveUpAt).toEqual(expect.any(String));
    const gaveUp = d.audits.find((x) => x.kind === 'cross-project-reply-scheduled-gave-up');
    expect(gaveUp.fields).toMatchObject({ fromEpicId: 'psess-y', epicId: 'psess-x', attempts: 24, lastError: entry.lastError });
    expect(typeof gaveUp.fields.lastError).toBe('string');
    expect(await deliverDueReplies({ appVersion: '0.142.0' }, d)).toMatchObject({ due: 0, failed: 0 });
  });
});

test('deliverDueReplies: a pass started while one is running is skipped and delivers nothing twice', async () => {
  await withSchedulerHome(async (home) => {
    const { b } = await setup();
    const d = deps('sent');
    await sendFeedbackReply(input(b, { message: 'Live in v{version}.', deliverWhen: { appVersionAbove: '0.141.0' } }), d);
    let release;
    const gate = new Promise((res) => { release = res; });
    const realSend = d.sendPrompt;
    d.sendPrompt = async (...args) => { await gate; return realSend(...args); };
    const p1 = deliverDueReplies({ appVersion: '0.142.0' }, d);
    await new Promise((res) => setImmediate(res));
    const second = await deliverDueReplies({ appVersion: '0.142.0' }, d);
    expect(second).toMatchObject({ skipped: true, due: 0, delivered: 0 });
    release();
    expect(await p1).toMatchObject({ due: 1, delivered: 1 });
    expect(d.calls).toHaveLength(1);
    expect(readLedger(home)[0].deliveredAt).toEqual(expect.any(String));
  });
});

test('replyPassLogMeta: a skipped pass is marked skipped: true; a run pass skipped: false', async () => {
  const { replyPassLogMeta } = require('../crossProjectReply.cjs');
  await withSchedulerHome(async () => {
    const { b } = await setup();
    const d = deps('sent');
    await sendFeedbackReply(input(b, { message: 'Live in v{version}.', deliverWhen: { appVersionAbove: '0.141.0' } }), d);
    let release;
    const gate = new Promise((res) => { release = res; });
    const realSend = d.sendPrompt;
    d.sendPrompt = async (...args) => { await gate; return realSend(...args); };
    const p1 = deliverDueReplies({ appVersion: '0.142.0' }, d);
    await new Promise((res) => setImmediate(res));
    const second = await deliverDueReplies({ appVersion: '0.142.0' }, d);
    expect(replyPassLogMeta(second, '0.142.0')).toEqual({ appVersion: '0.142.0', due: 0, delivered: 0, failed: 0, waiting: 0, skipped: true });
    release();
    const first = await p1;
    expect(replyPassLogMeta(first, '0.142.0')).toEqual({ appVersion: '0.142.0', due: 1, delivered: 1, failed: 0, waiting: 0, skipped: false });
  });
  expect(replyPassLogMeta({ due: 0, delivered: 0, failed: 0, error: 'boom' }, '1.0.0')).toEqual({ appVersion: '1.0.0', due: 0, delivered: 0, failed: 0, waiting: 0, skipped: false, error: 'boom' });
});

// ---------------------------------------------------------------------------
// Release claims (replyClaims.cjs): placeholders, Session Manager versions
// ---------------------------------------------------------------------------

const SM_PKG = JSON.stringify({ name: 'claude-code-session-manager', version: '0.0.0' });

/** A fake git: the tag exists and holds exactly `tagged` commits. */
function fakeGit(tagged, { tag = 'v0.143.0' } = {}) {
  const calls = [];
  const runGit = async (cwd, args) => {
    calls.push({ cwd, args });
    if (args[0] === 'rev-parse') {
      const ref = args[args.length - 1];
      if (ref === `refs/tags/${tag}^{commit}`) return '';
      if (ref.startsWith('refs/tags/')) throw new Error('no such tag');
      return '';
    }
    if (args[0] === 'merge-base') {
      if (args[3] === tag && tagged.includes(args[2])) return '';
      throw new Error('not ancestor');
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { runGit, calls };
}

test('release: {version} with neither deliverWhen nor release is refused 400 naming the token', async () => {
  const { b } = await setup();
  const d = deps();
  const r = await sendFeedbackReply(input(b, { message: 'Live in Session Manager {version}.' }), d);
  expect(r).toMatchObject({ ok: false, status: 400 });
  expect(r.error).toContain('{version}');
  expect(d.calls).toHaveLength(0);
});

test('release: <version> is refused even on a held reply', async () => {
  await withSchedulerHome(async (home) => {
    const { b } = await setup();
    const d = deps();
    const r = await sendFeedbackReply(input(b, {
      message: 'Live in v<version>.', deliverWhen: { appVersionAbove: '0.141.0' },
    }), d);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.error).toContain('<version>');
    expect(readLedger(home)).toHaveLength(0);
  });
});

test('release: a malformed release claim is refused 400', async () => {
  const { b } = await setup();
  fs.writeFileSync(path.join(b, 'package.json'), SM_PKG);
  const r = await sendFeedbackReply(input(b, { release: { commits: ['not-a-hash'] } }), deps());
  expect(r).toMatchObject({ ok: false, status: 400 });
  expect(r.error).toContain('invalid commit hash');
});

test('release: a replier that is not the Session Manager repo cannot send release', async () => {
  const { b } = await setup();
  const git = fakeGit(['abc1234']);
  const d = deps('sent', { appVersion: '0.143.0', runGit: git.runGit });
  const r = await sendFeedbackReply(input(b, { release: { commits: ['abc1234'] } }), d);
  expect(r).toMatchObject({ ok: false, status: 400 });
  expect(r.error).toContain('Session Manager repository');
  expect(d.calls).toHaveLength(0);
  expect(git.calls).toHaveLength(0);
});

test('release: a Session Manager done reply naming a version without release is refused', async () => {
  const { b } = await setup();
  fs.writeFileSync(path.join(b, 'package.json'), SM_PKG);
  const d = deps('sent', { appVersion: '0.143.0' });
  const r = await sendFeedbackReply(input(b, { message: 'Live in Session Manager 0.143.0.' }), d);
  expect(r).toMatchObject({ ok: false, status: 400 });
  expect(r.error).toContain('0.143.0');
  expect(r.error).toContain('release.commits');
  // a held SM done reply holding {version} without release is refused too.
  const held = await sendFeedbackReply(input(b, {
    message: 'Live in Session Manager {version}.', deliverWhen: { appVersionAbove: '0.142.0' },
  }), d);
  expect(held).toMatchObject({ ok: false, status: 400 });
  expect(d.calls).toHaveLength(0);
});

test('release: a tag that lacks a claimed commit is refused 409 and nothing is sent', async () => {
  const { a, b } = await setup();
  fs.writeFileSync(path.join(b, 'package.json'), SM_PKG);
  const before = events(a, 'psess-x').length;
  const git = fakeGit(['abc1234']);
  const d = deps('sent', { appVersion: '0.143.0', runGit: git.runGit });
  const r = await sendFeedbackReply(input(b, {
    message: 'Live in Session Manager {version}.', release: { commits: ['abc1234', 'def5678'] },
  }), d);
  expect(r).toMatchObject({ ok: false, status: 409 });
  expect(r.error).toContain('does not contain commit def5678');
  expect(d.calls).toHaveLength(0);
  expect(events(a, 'psess-x')).toHaveLength(before);
  expect(events(b, 'psess-y').some((e) => e.notice === 'cross-project-reply-sent')).toBe(false);
});

test('release: a message naming a version other than the running one is refused 409', async () => {
  const { b } = await setup();
  fs.writeFileSync(path.join(b, 'package.json'), SM_PKG);
  const git = fakeGit(['abc1234']);
  const d = deps('sent', { appVersion: () => '0.143.0', runGit: git.runGit });
  const r = await sendFeedbackReply(input(b, {
    message: 'Live in Session Manager 0.144.0.', release: { commits: ['abc1234'] },
  }), d);
  expect(r).toMatchObject({ ok: false, status: 409 });
  expect(r.error).toContain('0.144.0');
  expect(d.calls).toHaveLength(0);
});

test('release: a verified release fills {version}, delivers, and records release on the receipt', async () => {
  const { a, b } = await setup();
  fs.writeFileSync(path.join(b, 'package.json'), SM_PKG);
  const git = fakeGit(['abc1234']);
  const d = deps('sent', { appVersion: () => '0.143.0', runGit: git.runGit });
  const r = await sendFeedbackReply(input(b, {
    message: 'Live in Session Manager {version} (v{version}).', release: { commits: ['ABC1234'] },
  }), d);
  expect(r).toMatchObject({ ok: true, delivery: 'delivered', toEpicId: 'psess-x' });
  expect(git.calls.every((c) => c.cwd === b)).toBe(true);
  expect(d.calls).toHaveLength(1);
  expect(d.calls[0][1]).toContain('Live in Session Manager 0.143.0 (v0.143.0).');
  expect(d.calls[0][1]).not.toContain('{version}');
  expect(events(a, 'psess-x').at(-1).text).not.toContain('{version}');
  const receipt = events(b, 'psess-y').at(-1);
  expect(receipt.notice).toBe('cross-project-reply-sent');
  expect(receipt.reply.release).toEqual({ version: '0.143.0', commits: ['abc1234'] });
  const crypto = require('node:crypto');
  expect(receipt.reply.hash).toBe(crypto.createHash('sha256')
    .update('done\nLive in Session Manager 0.143.0 (v0.143.0).').digest('hex'));
});

// ---------------------------------------------------------------------------
// Held release replies: commits gate + placeholder guard on delivery
// ---------------------------------------------------------------------------

test('held release: commits are stored; a tag lacking a commit waits (no attempt), a tag holding it delivers', async () => {
  await withSchedulerHome(async (home) => {
    const { a, b } = await setup();
    fs.writeFileSync(path.join(b, 'package.json'), SM_PKG);
    const d = deps('sent');
    const held = await sendFeedbackReply(input(b, {
      message: 'Live in Session Manager {version}.',
      deliverWhen: { appVersionAbove: '0.141.0' },
      release: { commits: ['ABC1234'] },
    }), d);
    expect(held).toMatchObject({ ok: true, delivery: 'scheduled' });
    expect(readLedger(home)[0].commits).toEqual(['abc1234']);

    // 0.142.0 ships without the commit: the entry waits, spends no attempt.
    const old = fakeGit([], { tag: 'v0.142.0' });
    const r1 = await deliverDueReplies({ appVersion: '0.142.0' }, { ...d, runGit: old.runGit });
    expect(r1).toMatchObject({ due: 1, delivered: 0, failed: 0, waiting: 1 });
    expect(r1.results).toEqual([{
      id: readLedger(home)[0].id, ok: false, waiting: 'release tag v0.142.0 does not contain commit abc1234',
    }]);
    expect(old.calls.every((c) => c.cwd === b)).toBe(true);
    expect(d.calls).toHaveLength(0);
    expect(readLedger(home)[0]).toMatchObject({ attempts: 0, deliveredAt: null, lastError: null });

    // 0.143.0 contains it: delivered, receipt records the release.
    const now = fakeGit(['abc1234'], { tag: 'v0.143.0' });
    const r2 = await deliverDueReplies({ appVersion: '0.143.0' }, { ...d, runGit: now.runGit });
    expect(r2).toMatchObject({ due: 1, delivered: 1, failed: 0, waiting: 0 });
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0][1]).toContain('Live in Session Manager 0.143.0.');
    expect(events(a, 'psess-x').at(-1)).toMatchObject({ notice: 'cross-project-reply' });
    const receipt = events(b, 'psess-y').at(-1);
    expect(receipt.notice).toBe('cross-project-reply-sent');
    expect(receipt.reply.release).toEqual({ version: '0.143.0', commits: ['abc1234'] });
    expect(readLedger(home)[0]).toMatchObject({ deliveredVersion: '0.143.0', attempts: 0 });
  });
});

test('held reply: a placeholder still left after {version} is filled blocks delivery', async () => {
  await withSchedulerHome(async (home) => {
    const { a, b } = await setup();
    const d = deps('sent');
    const pendingReplies = require('../pendingReplies.cjs');
    // Written straight to the ledger: the route would refuse this message.
    pendingReplies.addPendingReply({
      replierCwd: b, yId: 'psess-y', goalText: 'g',
      thread: { cwd: a, epicId: 'psess-x', claudeSessionId: 'cs-x', legacy: false, mode: null },
      targetCwd: a, outcome: 'done',
      message: 'Live in {version}, see {{release}}.', appVersionAbove: '0.141.0',
    });
    const r = await deliverDueReplies({ appVersion: '0.142.0' }, d);
    expect(r).toMatchObject({ due: 1, delivered: 0, failed: 1, waiting: 0 });
    expect(r.results[0].error).toContain('{{release}}');
    expect(d.calls).toHaveLength(0);
    const [entry] = readLedger(home);
    expect(entry).toMatchObject({ attempts: 1, deliveredAt: null });
    expect(entry.lastError).toContain('{{release}}');
  });
});

test('held reply without commits: stored without a commits key, never runs git, receipt has no release', async () => {
  await withSchedulerHome(async (home) => {
    const { b } = await setup();
    const d = deps('sent');
    await sendFeedbackReply(input(b, { message: 'Live in v{version}.', deliverWhen: { appVersionAbove: '0.141.0' } }), d);
    expect('commits' in readLedger(home)[0]).toBe(false);
    const git = fakeGit([]);
    const r = await deliverDueReplies({ appVersion: '0.142.0' }, { ...d, runGit: git.runGit });
    expect(r).toMatchObject({ due: 1, delivered: 1, waiting: 0 });
    expect(git.calls).toHaveLength(0);
    const receipt = events(b, 'psess-y').at(-1);
    expect(receipt.notice).toBe('cross-project-reply-sent');
    expect(receipt.reply.release).toBeUndefined();
  });
});
