'use strict';

// Run: timeout 120 npx vitest run src/main/lib/__tests__/remoteTranscriptTail.test.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
import { describe, it, beforeEach, afterEach } from 'vitest';
const { readRecentChatMessages, buildRemoteConversation } = require('../remoteTranscriptTail.cjs');

describe('buildRemoteConversation', () => {
  const ex = (n, prompt = 'p' + n, result = 'r' + n) => ({ ts: `2026-01-01T00:00:0${n}Z`, prompt, result });
  const tm = (n, role = 'assistant', ts = `2026-01-01T00:00:0${n}Z`) => ({ role, text: 't' + n, ts, uuid: 'tu' + n });
  const bytes = (msgs) => msgs.reduce((s, m) => s + Buffer.byteLength(m.text, 'utf8'), 0);

  it('emits chronological user/assistant pairs with stable uuids', () => {
    const out = buildRemoteConversation({ exchanges: [ex(2), ex(1)], limit: 10 });
    assert.deepEqual(out.messages, [
      { role: 'user', text: 'p1', ts: '2026-01-01T00:00:01Z', uuid: 'ex:2026-01-01T00:00:01Z:u' },
      { role: 'assistant', text: 'r1', ts: '2026-01-01T00:00:01Z', uuid: 'ex:2026-01-01T00:00:01Z:a' },
      { role: 'user', text: 'p2', ts: '2026-01-01T00:00:02Z', uuid: 'ex:2026-01-01T00:00:02Z:u' },
      { role: 'assistant', text: 'r2', ts: '2026-01-01T00:00:02Z', uuid: 'ex:2026-01-01T00:00:02Z:a' },
    ]);
    assert.equal(out.hasMore, false);
    assert.equal(out.nextBefore, null);
  });

  it('skips a side whose trimmed text is empty', () => {
    const out = buildRemoteConversation({ exchanges: [ex(1, '  ', 'r')] });
    assert.deepEqual(out.messages.map((m) => m.role), ['assistant']);
  });

  it('appends only tail messages newer than the newest exchange, marked live', () => {
    const out = buildRemoteConversation({ exchanges: [ex(5), ex(4)], tail: [tm(3), tm(5), tm(6), tm(7, 'user'), tm(8, 'user', null)] });
    const live = out.messages.filter((m) => m.live);
    assert.deepEqual(live.map((m) => m.text), ['t6', 't7']);
    assert.equal(out.messages.slice(0, 4).some((m) => 'live' in m), false);
    assert.equal(out.messages.at(-1).text, 't7');
  });

  it('uses the whole tail (capped at 20 newest) when there are no exchanges', () => {
    const tail = Array.from({ length: 25 }, (_, i) => ({ role: 'user', text: 'm' + i, ts: null, uuid: 'u' + i }));
    const out = buildRemoteConversation({ exchanges: [], tail });
    assert.equal(out.messages.length, 20);
    assert.equal(out.messages[0].text, 'm5');
    assert.ok(out.messages.every((m) => m.live === true));
    assert.equal(out.hasMore, false);
  });

  it('returns no live messages when before > 0', () => {
    const out = buildRemoteConversation({ exchanges: [ex(1)], tail: [tm(9)], before: 3 });
    assert.equal(out.messages.some((m) => m.live), false);
    assert.equal(out.messages.length, 2);
  });

  it('sets hasMore and nextBefore when input exceeds limit', () => {
    const out = buildRemoteConversation({ exchanges: [ex(3), ex(2), ex(1)], limit: 2, before: 4 });
    assert.equal(out.hasMore, true);
    assert.equal(out.nextBefore, 6);
    assert.deepEqual(out.messages.map((m) => m.text), ['p2', 'r2', 'p3', 'r3']);
  });

  it('keeps total text bytes within 100000, dropping oldest exchanges', () => {
    const big = 'é'.repeat(1900);
    const exchanges = Array.from({ length: 10 }, (_, i) => ({ ts: `2026-01-01T00:00:${String(10 - i).padStart(2, '0')}Z`, prompt: big, result: 'x'.repeat(10000) }));
    const out = buildRemoteConversation({ exchanges, limit: 10 });
    assert.ok(bytes(out.messages) <= 100000);
    assert.ok(out.messages.length > 0 && out.messages.length < 20);
    assert.equal(out.hasMore, true);
    assert.equal(out.nextBefore, out.messages.length / 2);
    assert.equal(out.messages.at(-1).ts, exchanges[0].ts);
  });

  it('caps prompt at 2000 and result at 16000 chars with an ellipsis', () => {
    const out = buildRemoteConversation({ exchanges: [ex(1, 'p'.repeat(3000), 'r'.repeat(20000))] });
    assert.equal(out.messages[0].text.length, 2000);
    assert.ok(out.messages[0].text.endsWith('…'));
    assert.equal(out.messages[1].text.length, 16000);
    assert.ok(out.messages[1].text.endsWith('…'));
  });

  it('never throws on malformed entries', () => {
    const out = buildRemoteConversation({ exchanges: [null, { ts: 5 }, ex(1)], tail: [null, 3] });
    assert.deepEqual(out.messages.map((m) => m.text), ['p1', 'r1']);
  });
});

const u = (text, extra = {}) => JSON.stringify({ type: 'user', uuid: 'u-' + text, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text }, ...extra });
const a = (text, extra = {}) => JSON.stringify({ type: 'assistant', uuid: 'a-' + text, timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });

describe('readRecentChatMessages', () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtt-'));
    file = path.join(dir, 't.jsonl');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (lines) => fs.writeFileSync(file, lines.join('\n') + '\n');

  it('keeps only human-readable chat from a mixed fixture', async () => {
    write([
      u('hello'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'out' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'hi there' }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }),
      u('meta line', { isMeta: true }),
      a('side', { isSidechain: true }),
      a('   '),
    ]);
    const out = await readRecentChatMessages(file);
    assert.deepEqual(out, [
      { role: 'user', text: 'hello', ts: '2026-01-01T00:00:00Z', uuid: 'u-hello' },
      { role: 'assistant', text: 'hi there', ts: null, uuid: 'a1' },
    ]);
  });

  it('returns the last N oldest-first and clamps limit', async () => {
    write(Array.from({ length: 5 }, (_, i) => u('m' + i)));
    assert.deepEqual((await readRecentChatMessages(file, { limit: 2 })).map((m) => m.text), ['m3', 'm4']);
    assert.equal((await readRecentChatMessages(file, { limit: 0 })).length, 1);
    assert.equal((await readRecentChatMessages(file, { limit: 1000 })).length, 5);
  });

  it('drops the partial first line when the tail starts mid-file', async () => {
    const lines = [u('first-old'), u('second'), u('third')];
    write(lines);
    const maxBytes = Buffer.byteLength(lines[1] + '\n' + lines[2] + '\n') + 5; // cuts into line 0
    const out = await readRecentChatMessages(file, { maxBytes });
    assert.deepEqual(out.map((m) => m.text), ['second', 'third']);
  });

  it('keeps the first line when the tail starts exactly on a boundary', async () => {
    const lines = [u('one'), u('two')];
    write(lines);
    const out = await readRecentChatMessages(file, { maxBytes: Buffer.byteLength(lines[1] + '\n') });
    assert.deepEqual(out.map((m) => m.text), ['two']);
  });

  it('skips malformed lines without throwing', async () => {
    write([u('a1'), '{not json', 'null', u('a2')]);
    assert.deepEqual((await readRecentChatMessages(file)).map((m) => m.text), ['a1', 'a2']);
  });

  it('resolves [] for a missing file or non-string path', async () => {
    assert.deepEqual(await readRecentChatMessages(path.join(dir, 'nope.jsonl')), []);
    assert.deepEqual(await readRecentChatMessages(undefined), []);
    assert.deepEqual(await readRecentChatMessages(42), []);
  });

  it('truncates long text to 4000 chars with a trailing ellipsis', async () => {
    write([u('x'.repeat(5000))]);
    const [m] = await readRecentChatMessages(file);
    assert.equal(m.text.length, 4000);
    assert.ok(m.text.endsWith('…'));
  });
});
