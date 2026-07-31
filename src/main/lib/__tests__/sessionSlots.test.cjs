// sessionSlots.cjs — the Session-Manager-owned machine-wide claude -p pool.
// vitest globals (test/beforeEach/afterEach) — same convention as the other .cjs tests.
const assert = require('node:assert');
const slots = require('../sessionSlots.cjs');

beforeEach(() => slots.__resetForTests());
afterEach(() => {
  slots.__resetForTests();
  delete process.env.SM_SESSION_SLOTS;
});

test('pool defaults to 3 slots and exhausts', () => {
  assert.equal(slots.totalSlots(), 3);
  const t1 = slots.acquire('a');
  const t2 = slots.acquire('b');
  const t3 = slots.acquire('c');
  assert.ok(t1 && t2 && t3);
  assert.equal(slots.available(), 0);
  assert.equal(slots.acquire('d'), null, 'fourth acquire must be refused');
  slots.release(t2);
  assert.equal(slots.available(), 1);
  assert.ok(slots.acquire('d'));
});

test('SM_SESSION_SLOTS overrides, clamped to [1,3]', () => {
  process.env.SM_SESSION_SLOTS = '1';
  assert.equal(slots.totalSlots(), 1);
  process.env.SM_SESSION_SLOTS = '9';
  assert.equal(slots.totalSlots(), 3, 'clamped high');
  process.env.SM_SESSION_SLOTS = '0';
  assert.equal(slots.totalSlots(), 1, 'clamped low');
  process.env.SM_SESSION_SLOTS = 'junk';
  assert.equal(slots.totalSlots(), 3, 'non-numeric falls back to default');
});

test('release is idempotent and notifies subscribers exactly on real releases', () => {
  let notified = 0;
  const unsub = slots.subscribe(() => { notified += 1; });
  const t = slots.acquire('a');
  assert.equal(slots.release(t), true);
  assert.equal(slots.release(t), false, 'double release is a no-op');
  assert.equal(notified, 1, 'no notification for the no-op release');
  unsub();
  const t2 = slots.acquire('b');
  slots.release(t2);
  assert.equal(notified, 1, 'unsubscribed listener stays quiet');
});

test('snapshot names holders for attribution', () => {
  slots.acquire('scheduler:42-fix-thing');
  slots.acquire('chat:tab-1');
  const snap = slots.snapshot();
  assert.equal(snap.inUse, 2);
  assert.deepEqual(snap.holders.map((h) => h.owner).sort(), ['chat:tab-1', 'scheduler:42-fix-thing']);
});
