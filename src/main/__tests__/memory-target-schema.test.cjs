'use strict';

// memory:ask / memory:proposeFix accept the renderer's raw { question|name, target, contextName? }
// object (remote relay path) and the legacy flat shape; both parse to the same flattened payload.
import { test } from 'vitest';
const assert = require('node:assert/strict');
const { schemas: s } = require('../ipcSchemas.cjs');

const agent = { name: 'dev-lead', scope: 'user' };

test('ask: nested target is flattened to top-level keys', () => {
  const out = s.memoryAsk.parse({
    question: 'why?',
    contextName: 'some-note.md',
    target: { workspace: 'ws-1', cwd: '/home/x/proj', agent },
  });
  assert.deepStrictEqual(out, { question: 'why?', contextName: 'some-note.md', workspace: 'ws-1', cwd: '/home/x/proj', agent });
});

test('proposeFix: nested target is flattened to top-level keys', () => {
  const out = s.memoryProposeFix.parse({ name: 'some-note.md', target: { workspace: 'ws-1', cwd: '/home/x/proj' } });
  assert.deepStrictEqual(out, { name: 'some-note.md', workspace: 'ws-1', cwd: '/home/x/proj' });
});

test('legacy flat shape parses to the same object as the nested shape', () => {
  const flat = s.memoryAsk.parse({ question: 'q', workspace: 'ws-1', cwd: '/p' });
  const nested = s.memoryAsk.parse({ question: 'q', target: { workspace: 'ws-1', cwd: '/p' } });
  assert.deepStrictEqual(flat, nested);
  const flatFix = s.memoryProposeFix.parse({ name: 'n.md', workspace: 'ws-1', cwd: '/p' });
  const nestedFix = s.memoryProposeFix.parse({ name: 'n.md', target: { workspace: 'ws-1', cwd: '/p' } });
  assert.deepStrictEqual(flatFix, nestedFix);
});

test('falsy target values and an empty contextName are dropped', () => {
  const out = s.memoryAsk.parse({
    question: 'q',
    contextName: '',
    target: { workspace: 'ws-1', cwd: '', agent: null },
  });
  assert.deepStrictEqual(out, { question: 'q', workspace: 'ws-1' });
  assert.deepStrictEqual(s.memoryProposeFix.parse({ name: 'n.md', target: undefined }), { name: 'n.md' });
  assert.deepStrictEqual(s.memoryProposeFix.parse({ name: 'n.md', target: {} }), { name: 'n.md' });
});

test('an unknown key inside target is rejected', () => {
  assert.equal(s.memoryAsk.safeParse({ question: 'q', target: { workspace: 'ws-1', evil: 1 } }).success, false);
  assert.equal(s.memoryProposeFix.safeParse({ name: 'n.md', target: { cwd: '/p', evil: 1 } }).success, false);
});

test('an unknown top-level key is rejected', () => {
  assert.equal(s.memoryAsk.safeParse({ question: 'q', evil: 1 }).success, false);
  assert.equal(s.memoryProposeFix.safeParse({ name: 'n.md', target: { cwd: '/p' }, evil: 1 }).success, false);
});

test('verify/archive/restore keep the plain flat memoryNamed schema', () => {
  assert.equal(s.memoryVerify.safeParse({ name: 'n.md', target: { cwd: '/p' } }).success, false);
  assert.equal(s.memoryVerify.safeParse({ name: 'n.md', cwd: '/p' }).success, true);
});
