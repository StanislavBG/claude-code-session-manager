/**
 * ipcSchemas-appPreview.test.cjs — appPreview payload schemas.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/ipcSchemas-appPreview.test.cjs
 */

'use strict';

import { test, expect, describe } from 'vitest';
const { schemas, APP_PREVIEW_SCRIPT_RE } = require('../ipcSchemas.cjs');
const { SCRIPT_NAME_RE } = require('../lib/app-preview/appPreviewScripts.cjs');

const ok = (s, p) => s.safeParse(p).success;

describe('appPreview schemas', () => {
  test('accept valid payloads', () => {
    expect(ok(schemas.appPreviewScripts, { cwd: '/proj', epicId: 'my-epic-1234abcd' })).toBe(true);
    expect(ok(schemas.appPreviewStart, { cwd: '/proj', epicId: 'my-epic-1234abcd', script: 'dev' })).toBe(true);
    expect(ok(schemas.appPreviewStart, { cwd: '/proj', epicId: 'e', script: 'dev:web' })).toBe(true);
    expect(ok(schemas.appPreviewStart, { cwd: '/proj', epicId: 'e', script: '@scope/start' })).toBe(true);
    expect(ok(schemas.appPreviewStop, { epicId: 'my-epic-1234abcd' })).toBe(true);
  });

  test('reject hostile script names', () => {
    expect(ok(schemas.appPreviewStart, { cwd: '/proj', epicId: 'e', script: '--inspect' })).toBe(false);
    expect(ok(schemas.appPreviewStart, { cwd: '/proj', epicId: 'e', script: 'dev; rm -rf /' })).toBe(false);
  });

  test('reject __proto__ epicId on all three', () => {
    expect(ok(schemas.appPreviewScripts, { cwd: '/proj', epicId: '__proto__' })).toBe(false);
    expect(ok(schemas.appPreviewStart, { cwd: '/proj', epicId: '__proto__', script: 'dev' })).toBe(false);
    expect(ok(schemas.appPreviewStop, { epicId: '__proto__' })).toBe(false);
  });

  test('reject empty / oversized cwd', () => {
    expect(ok(schemas.appPreviewScripts, { cwd: '', epicId: 'e' })).toBe(false);
    expect(ok(schemas.appPreviewScripts, { cwd: 'x'.repeat(4097), epicId: 'e' })).toBe(false);
  });

  test('script regex mirrors SCRIPT_NAME_RE', () => {
    expect(APP_PREVIEW_SCRIPT_RE.source).toBe(SCRIPT_NAME_RE.source);
  });
});
