'use strict';

// Run: timeout 60 npx vitest run src/main/lib/__tests__/quietMachineLease.test.cjs

const assert = require('node:assert/strict');
const lease = require('../quietMachineLease.cjs');

afterEach(() => {
  lease.__resetForTests();
});

test('free lease: isHeld false, acquire succeeds and reports the holder', () => {
  assert.equal(lease.isHeld(), false);
  assert.equal(lease.acquire('101-quiet'), true);
  assert.equal(lease.isHeld(), true);
  assert.equal(lease.holder(), '101-quiet');
});

test('a second acquire while held fails — exclusive by construction', () => {
  assert.equal(lease.acquire('101-quiet'), true);
  assert.equal(lease.acquire('102-other'), false);
  assert.equal(lease.holder(), '101-quiet');
});

test('release frees the lease so the next acquire can succeed', () => {
  lease.acquire('101-quiet');
  assert.equal(lease.release('101-quiet'), true);
  assert.equal(lease.isHeld(), false);
  assert.equal(lease.acquire('102-other'), true);
});

test('release is idempotent: releasing an unheld lease, or a slug that does not hold it, is a no-op', () => {
  assert.equal(lease.release('nobody'), false);
  lease.acquire('101-quiet');
  assert.equal(lease.release('wrong-slug'), false);
  assert.equal(lease.isHeld(), true);
  assert.equal(lease.release('101-quiet'), true);
  assert.equal(lease.release('101-quiet'), false);
});
