/**
 * ipcSchemas-external-new-session-result.test.cjs — renderer's report for a
 * chat:external-new-session that carried a requestId (POST /admin/macros/run).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/ipcSchemas-external-new-session-result.test.cjs
 */

'use strict';

import { test, expect, describe } from 'vitest';
const { schemas } = require('../ipcSchemas.cjs');

const ok = (p) => schemas.chatExternalNewSessionResult.safeParse(p).success;

describe('chatExternalNewSessionResult schema', () => {
  test('is exported', () => {
    expect(schemas.chatExternalNewSessionResult).toBeDefined();
  });

  test('accepts a success with an epicId', () => {
    expect(ok({ requestId: 'req-1', ok: true, epicId: 'epic-abc_1.2' })).toBe(true);
  });

  test('accepts a failure with an error', () => {
    expect(ok({ requestId: 'req-1', ok: false, error: 'unknown agent' })).toBe(true);
  });

  test('rejects an unknown key', () => {
    expect(ok({ requestId: 'req-1', ok: true, epicId: 'e1', extra: 1 })).toBe(false);
  });

  test('rejects an empty requestId', () => {
    expect(ok({ requestId: '', ok: true, epicId: 'e1' })).toBe(false);
  });

  test("rejects an epicId containing '/'", () => {
    expect(ok({ requestId: 'req-1', ok: true, epicId: 'a/b' })).toBe(false);
  });
});
