/**
 * docEdit.test.cjs — unit tests for docEdit.cjs's pure helpers (PRD 638).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/docEdit.test.cjs
 */

'use strict';

import { test, expect, describe, beforeEach, vi } from 'vitest';

// docEdit.cjs requires chatRunner.cjs at module scope and calls `chatRunner.run(...)`
// as a property access, so patching `run` on the already-required (cached) module
// object — before docEdit.cjs's own require resolves to the same singleton — is
// enough to intercept it, mirroring the exchanges.cjs patch pattern in chatRunner.spec.ts.
const chatRunnerModule = require('../chatRunner.cjs');
const runCalls = [];
beforeEach(() => { runCalls.length = 0; });
chatRunnerModule.run = (opts) => { runCalls.push(opts); };

const { parseDocEdit, editPrompt, truncateDocumentText, MAX_DOC_CONTEXT, docEditViaSession, attachWindow } = require('../docEdit.cjs');
const { duplicateNameFor } = require('../files.cjs');

const broadcasts = [];
attachWindow({
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: (channel, payload) => broadcasts.push({ channel, payload }) },
});
beforeEach(() => { broadcasts.length = 0; });

describe('parseDocEdit', () => {
  test('valid JSON', () => {
    const result = parseDocEdit('{"after":"rewritten text"}');
    expect(result).toEqual({ ok: true, after: 'rewritten text' });
  });

  test('JSON embedded in prose', () => {
    const result = parseDocEdit('Sure, here you go:\n{"after":"rewritten text"}\nHope that helps!');
    expect(result).toEqual({ ok: true, after: 'rewritten text' });
  });

  test('missing after', () => {
    const result = parseDocEdit('{"other":"value"}');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('empty after', () => {
    const result = parseDocEdit('{"after":""}');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('non-string after', () => {
    const result = parseDocEdit('{"after":42}');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('over-length after', () => {
    const result = parseDocEdit(JSON.stringify({ after: 'x'.repeat(16001) }));
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('no JSON object in output at all', () => {
    const result = parseDocEdit('not json at all, just prose garbage');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('empty/null input', () => {
    expect(parseDocEdit('').ok).toBe(false);
    expect(parseDocEdit(null).ok).toBe(false);
  });
});

describe('editPrompt', () => {
  test('omits the document block when documentText is absent', () => {
    const prompt = editPrompt('selected text', 'make it concise');
    expect(prompt).not.toMatch(/<document_/);
  });

  test('includes a nonce-tagged document block when documentText is provided', () => {
    const prompt = editPrompt('selected text', 'make it concise', 'the whole document');
    expect(prompt).toMatch(/<document_[0-9a-f]+>/);
    expect(prompt).toContain('the whole document');
  });

  test('truncates an oversized documentText before embedding it', () => {
    const huge = 'x'.repeat(MAX_DOC_CONTEXT + 5000);
    const prompt = editPrompt('selected text', 'make it concise', huge);
    expect(prompt).toContain('[...document truncated for length...]');
    expect(prompt.length).toBeLessThan(huge.length + 2000);
  });
});

describe('truncateDocumentText', () => {
  test('passes short text through unchanged', () => {
    expect(truncateDocumentText('short')).toBe('short');
  });

  test('truncates to the documented head+tail scheme rather than dropping or erroring', () => {
    const head = 'H'.repeat(40000);
    const tail = 'T'.repeat(20000);
    const middle = 'M'.repeat(10000);
    const result = truncateDocumentText(head + middle + tail);
    expect(result).toBe(`${head}\n\n[...document truncated for length...]\n\n${tail}`);
    expect(result).not.toContain('M');
  });
});

describe('docEditViaSession', () => {
  test('builds its prompt via the shared editPrompt and calls chatRunner.run with resume+silent', () => {
    docEditViaSession({
      tabId: 'tab-1',
      sessionId: 'chat-session-1',
      cwd: '/home/user/project',
      before: 'old text',
      instruction: 'make it punchier',
      documentText: 'the whole document',
      requestId: 'req-1',
    });

    expect(runCalls).toHaveLength(1);
    const call = runCalls[0];
    expect(call.tabId).toBe('tab-1');
    expect(call.sessionId).toBe('chat-session-1');
    expect(call.cwd).toBe('/home/user/project');
    expect(call.resume).toBe(true);
    expect(call.silent).toBe(true);
    expect(typeof call.onSilentResult).toBe('function');

    // The prompt is the shared editPrompt's output (nonce-tagged, so compare
    // structurally rather than byte-for-byte) prefixed with the anti-injection
    // system framing — not a second, forked prompt builder.
    expect(call.prompt).toContain('Rewrite the SELECTION below per the INSTRUCTION');
    expect(call.prompt).toMatch(/<selection_[0-9a-f]+>\nold text\n<\/selection_[0-9a-f]+>/);
    expect(call.prompt).toContain('deterministic document-rewrite assistant');
  });

  test('onSilentResult parses the reply and broadcasts docedit:session-result', () => {
    docEditViaSession({
      tabId: 'tab-2',
      sessionId: 'chat-session-2',
      cwd: '/home/user/project',
      before: 'old text',
      instruction: 'shorten it',
      requestId: 'req-2',
    });

    const { onSilentResult } = runCalls[runCalls.length - 1];
    onSilentResult('{"after":"new text"}');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toEqual({
      channel: 'docedit:session-result',
      payload: { tabId: 'tab-2', requestId: 'req-2', ok: true, after: 'new text' },
    });
  });

  test('onSilentResult reports a parse failure as ok:false', () => {
    docEditViaSession({
      tabId: 'tab-3',
      sessionId: 'chat-session-3',
      cwd: '/home/user/project',
      before: 'old text',
      instruction: 'shorten it',
      requestId: 'req-3',
    });

    const { onSilentResult } = runCalls[runCalls.length - 1];
    onSilentResult('not json at all');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].payload.ok).toBe(false);
    expect(broadcasts[0].payload.error).toBeTruthy();
  });

  test('splits off the stop-signal protocol and reports it as a clarification request', () => {
    docEditViaSession({
      tabId: 'tab-4',
      sessionId: 'chat-session-4',
      cwd: '/home/user/project',
      before: 'old text',
      instruction: 'shorten it',
      requestId: 'req-4',
    });

    const { onSilentResult } = runCalls[runCalls.length - 1];
    onSilentResult('<<<SM_NEEDS_INPUT>>>\n{"questions":["which section?"]}');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].payload.ok).toBe(false);
    expect(broadcasts[0].payload.error).toContain('which section?');
  });

  test('times out and broadcasts a failure if chatRunner never calls onSilentResult (error/timeout/cancel/collision on the silent lane)', () => {
    vi.useFakeTimers();
    try {
      docEditViaSession({
        tabId: 'tab-5',
        sessionId: 'chat-session-5',
        cwd: '/home/user/project',
        before: 'old text',
        instruction: 'shorten it',
        requestId: 'req-5',
      });

      // chatRunner.run() is a no-op stub in this test (never invokes
      // onSilentResult) — nothing should broadcast until the bound elapses.
      expect(broadcasts).toHaveLength(0);

      vi.advanceTimersByTime(120_000);
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toEqual({
        channel: 'docedit:session-result',
        payload: { tabId: 'tab-5', requestId: 'req-5', ok: false, error: 'timed out waiting on the background session' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('duplicateNameFor', () => {
  test('fresh name — no collision', () => {
    const result = duplicateNameFor('/tmp/dir', 'notes.txt', () => false);
    expect(result).toEqual({ ok: true, name: 'notes-copy.txt' });
  });

  test('collision on the first candidate falls through to -copy-2', () => {
    const taken = new Set(['/tmp/dir/notes-copy.txt']);
    const result = duplicateNameFor('/tmp/dir', 'notes.txt', (full) => taken.has(full));
    expect(result).toEqual({ ok: true, name: 'notes-copy-2.txt' });
  });

  test('preserves extension-less basenames', () => {
    const result = duplicateNameFor('/tmp/dir', 'README', () => false);
    expect(result).toEqual({ ok: true, name: 'README-copy' });
  });

  test('cap exhausted after 20 attempts returns an error', () => {
    const result = duplicateNameFor('/tmp/dir', 'notes.txt', () => true);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
