'use strict';

// Run: timeout 120 npx vitest run src/main/lib/__tests__/remoteTranscriptTail.test.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
import { describe, it, beforeEach, afterEach } from 'vitest';
const { readRecentChatMessages } = require('../remoteTranscriptTail.cjs');

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
