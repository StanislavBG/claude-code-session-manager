/**
 * feedbackBoxKeys.test.cjs — machine-local widget box key store.
 *
 * Run: timeout 300 npx vitest run src/main/lib/feedback-remote/__tests__/feedbackBoxKeys.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../feedbackBoxKeys.cjs');

/** @type {string|undefined} */
let prevHome;
/** @type {string} */
let tmp;

beforeEach(() => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-boxkeys-'));
  process.env.SM_SCHEDULER_HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** @param {string} id @param {string} [cwd] */
function rec(id, cwd = '/proj/a') {
  return {
    boxId: id,
    projectCwd: cwd,
    label: `Box ${id}`,
    publicKey: `pub-${id}`,
    fingerprint: `fp-${id}`,
    privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: `secret-${id}` },
    createdAt: 1700000000000,
  };
}

test('store path is <schedulerHome>/feedback-boxes.json', () => {
  expect(store.storeFile()).toBe(path.join(tmp, 'feedback-boxes.json'));
});

test('add / list / get / remove round trip', async () => {
  await store.addBox(rec('b1', '/proj/a'));
  await store.addBox(rec('b2', '/proj/b'));
  const all = await store.listBoxes();
  expect(all.map((b) => b.boxId).sort()).toEqual(['b1', 'b2']);
  const a = await store.listBoxes({ projectCwd: '/proj/a' });
  expect(a).toEqual([{ boxId: 'b1', projectCwd: '/proj/a', label: 'Box b1', publicKey: 'pub-b1', fingerprint: 'fp-b1', createdAt: 1700000000000 }]);
  const jwk = await store.getPrivateKey('b2');
  expect(jwk && jwk.d).toBe('secret-b2');
  expect(await store.getPrivateKey('nope')).toBeNull();
  expect(await store.removeBox('b1')).toBe(true);
  expect(await store.removeBox('b1')).toBe(false);
  expect((await store.listBoxes()).map((b) => b.boxId)).toEqual(['b2']);
  expect(await store.getPrivateKey('b1')).toBeNull();
});

test('rejects a duplicate boxId and malformed input', async () => {
  await store.addBox(rec('b1'));
  await expect(store.addBox(rec('b1'))).rejects.toThrow(/exists/);
  await expect(store.addBox(/** @type {any} */ ({ ...rec('b3'), privateKeyJwk: null }))).rejects.toThrow();
  await expect(store.addBox(/** @type {any} */ ({ ...rec('b4'), boxId: '' }))).rejects.toThrow();
  expect((await store.listBoxes()).length).toBe(1);
});

test.skipIf(process.platform === 'win32')('file is written with mode 0600', async () => {
  await store.addBox(rec('b1'));
  const st = fs.statSync(path.join(tmp, 'feedback-boxes.json'));
  expect(st.mode & 0o777).toBe(0o600);
  await store.removeBox('b1');
  expect(fs.statSync(path.join(tmp, 'feedback-boxes.json')).mode & 0o777).toBe(0o600);
});

test('missing file reads as empty; corrupt file reads as empty and is recoverable', async () => {
  expect(await store.listBoxes()).toEqual([]);
  expect(await store.getPrivateKey('b1')).toBeNull();
  fs.writeFileSync(path.join(tmp, 'feedback-boxes.json'), '{not json');
  expect(await store.listBoxes()).toEqual([]);
  await store.addBox(rec('b1'));
  expect((await store.listBoxes()).map((b) => b.boxId)).toEqual(['b1']);
  fs.writeFileSync(path.join(tmp, 'feedback-boxes.json'), JSON.stringify({ boxes: 'nope' }));
  expect(await store.listBoxes()).toEqual([]);
});

test('concurrent adds do not lose a record', async () => {
  const ids = Array.from({ length: 25 }, (_, i) => `c${i}`);
  await Promise.all(ids.map((id) => store.addBox(rec(id))));
  const got = (await store.listBoxes()).map((b) => b.boxId).sort();
  expect(got).toEqual([...ids].sort());
  for (const id of ids) expect((await store.getPrivateKey(id))?.d).toBe(`secret-${id}`);
});

test('listBoxes never contains a private key', async () => {
  await store.addBox(rec('b1', '/proj/a'));
  await store.addBox(rec('b2', '/proj/b'));
  for (const list of [await store.listBoxes(), await store.listBoxes({ projectCwd: '/proj/a' })]) {
    const text = JSON.stringify(list);
    expect(text).not.toContain('privateKeyJwk');
    expect(text).not.toContain('secret-');
    for (const b of list) expect(Object.prototype.hasOwnProperty.call(b, 'privateKeyJwk')).toBe(false);
  }
});

test('identitySecret: created on first request, stable, 32 random bytes base64url', async () => {
  await store.addBox(rec('b1'));
  await store.addBox(rec('b2'));
  const s1 = await store.getIdentitySecret('b1');
  expect(s1).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(/** @type {string} */ (s1), 'base64url').length).toBe(32);
  expect(await store.getIdentitySecret('b1')).toBe(s1);
  const s2 = await store.getIdentitySecret('b2');
  expect(s2).not.toBe(s1);
  expect(await store.getIdentitySecret('nope')).toBeNull();
  expect(await store.getIdentitySecret('')).toBeNull();
  // private key untouched by the secret write
  expect((await store.getPrivateKey('b1'))?.d).toBe('secret-b1');
});

test('rotateIdentitySecret replaces the secret; unknown box is null', async () => {
  await store.addBox(rec('b1'));
  const before = await store.getIdentitySecret('b1');
  const rotated = await store.rotateIdentitySecret('b1');
  expect(rotated).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(rotated).not.toBe(before);
  expect(await store.getIdentitySecret('b1')).toBe(rotated);
  expect(await store.rotateIdentitySecret('nope')).toBeNull();
  // rotate on a box with no secret yet creates one
  await store.addBox(rec('b2'));
  const fresh = await store.rotateIdentitySecret('b2');
  expect(await store.getIdentitySecret('b2')).toBe(fresh);
});

test('listBoxes never contains the identity secret', async () => {
  await store.addBox(rec('b1', '/proj/a'));
  const secret = /** @type {string} */ (await store.getIdentitySecret('b1'));
  const rotated = /** @type {string} */ (await store.rotateIdentitySecret('b1'));
  for (const list of [await store.listBoxes(), await store.listBoxes({ projectCwd: '/proj/a' })]) {
    const text = JSON.stringify(list);
    expect(text).not.toContain('identitySecret');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(rotated);
  }
});
