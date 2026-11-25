/**
 * auditLog-kind-wins.test.cjs — appendAuditEvent's first-argument kind always wins;
 * a colliding fields.kind is kept as fieldKind.
 *
 * Run: timeout 120 npx vitest run src/main/lib/telemetry/__tests__/auditLog-kind-wins.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendAuditEvent } = require('../auditLog.cjs');

let dir;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditlog-kind-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function lastRecord(target) {
  const lines = fs.readFileSync(target, 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

test('first-argument kind wins; colliding fields.kind is stored as fieldKind', () => {
  const target = path.join(dir, 'collide.jsonl');
  appendAuditEvent('a_kind', { kind: 'x', n: 1 }, { target });
  const rec = lastRecord(target);
  expect(rec.kind).toBe('a_kind');
  expect(rec.fieldKind).toBe('x');
  expect(rec.n).toBe(1);
});

test('no fields.kind → no fieldKind', () => {
  const target = path.join(dir, 'plain.jsonl');
  appendAuditEvent('b_kind', { n: 2 }, { target });
  const rec = lastRecord(target);
  expect(rec.kind).toBe('b_kind');
  expect(rec.n).toBe(2);
  expect('fieldKind' in rec).toBe(false);
});
