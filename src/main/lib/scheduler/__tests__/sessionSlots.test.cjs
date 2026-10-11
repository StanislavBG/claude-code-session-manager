// sessionSlots.cjs — the Session-Manager-owned machine-wide claude -p pool.
// vitest globals (test/beforeEach/afterEach) — same convention as the other .cjs tests.
const assert = require('node:assert');
const fs = require('node:fs');
const slots = require('../sessionSlots.cjs');

// Same real-homedir convention as queueStore.cjs's own tests — no path override exists
// for this module, so keep the persisted file removed except where a test deliberately
// wants it, and restore it to unset afterward.
const CONFIG_PATH = require('node:path').join(require('node:os').homedir(), '.claude', 'session-manager', 'session-slots-config.json');
function removeConfig() {
  try { fs.unlinkSync(CONFIG_PATH); } catch { /* already absent */ }
}

beforeEach(() => {
  slots.__resetForTests();
  removeConfig();
});
afterEach(() => {
  slots.__resetForTests();
  delete process.env.SM_SESSION_SLOTS;
  removeConfig();
});

test('pool defaults to 5 slots and exhausts', () => {
  assert.equal(slots.totalSlots(), 5);
  const tokens = ['a', 'b', 'c', 'd', 'e'].map((o) => slots.acquire(o));
  assert.ok(tokens.every(Boolean));
  assert.equal(slots.available(), 0);
  assert.equal(slots.acquire('f'), null, 'sixth acquire must be refused');
  slots.release(tokens[1]);
  assert.equal(slots.available(), 1);
  assert.ok(slots.acquire('f'));
});

test('SM_SESSION_SLOTS overrides, clamped to [0, 10]', () => {
  process.env.SM_SESSION_SLOTS = '1';
  assert.equal(slots.totalSlots(), 1);
  process.env.SM_SESSION_SLOTS = '20';
  assert.equal(slots.totalSlots(), 10, 'clamped high');
  process.env.SM_SESSION_SLOTS = '0';
  assert.equal(slots.totalSlots(), 0, '0 is a legal explicit value (pauses new launches)');
  process.env.SM_SESSION_SLOTS = '-5';
  assert.equal(slots.totalSlots(), 0, 'clamped low');
  process.env.SM_SESSION_SLOTS = 'junk';
  assert.equal(slots.totalSlots(), 5, 'non-numeric falls back to default');
});

test('cap of 0 pauses all new acquisitions without touching existing holders', () => {
  const t = slots.acquire('a');
  assert.ok(t);
  process.env.SM_SESSION_SLOTS = '0';
  assert.equal(slots.acquire('b'), null);
  assert.equal(slots.inUse(), 1, 'existing holder is untouched by the pause');
  slots.release(t);
  assert.equal(slots.inUse(), 0);
});

test('setCap persists a value that totalSlots() picks up without an env override', () => {
  slots.setCap(8);
  assert.equal(slots.totalSlots(), 8);
  slots.setCap(0);
  assert.equal(slots.totalSlots(), 0);
});

test('setCap rejects out-of-range or non-integer values', () => {
  assert.throws(() => slots.setCap(11));
  assert.throws(() => slots.setCap(-1));
  assert.throws(() => slots.setCap(2.5));
});

test('setCap notifies subscribers so a raised cap can wake waiting consumers', () => {
  let notified = 0;
  const unsub = slots.subscribe(() => { notified += 1; });
  slots.setCap(7);
  assert.equal(notified, 1);
  unsub();
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

// ── expireDead: fail-closed release of provably-dead scheduler reservations ──
const NOW = 10_000_000;
const GRACE = 10 * 60 * 1000;

test('expireDead: stamped dead pid with no live row is released', () => {
  const t = slots.acquire('scheduler:a', { claimedAt: NOW - 1000 });
  slots.stampPid(t, 4242);
  const out = slots.expireDead({ liveSlugs: new Set(), pidAlive: () => false, now: NOW, graceMs: GRACE });
  assert.deepEqual(out, ['scheduler:a']);
  assert.equal(slots.inUse(), 0);
});

test('expireDead: a live pid or a live row keeps the token', () => {
  const t1 = slots.acquire('scheduler:a', { claimedAt: NOW - 2 * GRACE });
  slots.stampPid(t1, 4242);
  const t2 = slots.acquire('scheduler:b', { claimedAt: NOW - 2 * GRACE });
  slots.expireDead({ liveSlugs: new Set(['b']), pidAlive: () => true, now: NOW, graceMs: GRACE });
  assert.equal(slots.inUse(), 2, 'live pid (a) and live row (b) both survive');
  assert.ok(t1 && t2);
});

test('expireDead: pidless token expires only past the grace window', () => {
  slots.acquire('scheduler:old', { claimedAt: NOW - GRACE - 1 });
  slots.acquire('scheduler:fresh', { claimedAt: NOW - GRACE + 1000 });
  const out = slots.expireDead({ liveSlugs: new Set(), pidAlive: () => false, now: NOW, graceMs: GRACE });
  assert.deepEqual(out, ['scheduler:old']);
  assert.equal(slots.inUse(), 1);
});

test('expireDead: chat and project-brief tokens are never touched', () => {
  slots.acquire('chat:tab1', { claimedAt: 0 });
  slots.acquire('project-brief:x', { claimedAt: 0 });
  const out = slots.expireDead({ liveSlugs: new Set(), pidAlive: () => false, now: NOW, graceMs: GRACE });
  assert.deepEqual(out, []);
  assert.equal(slots.inUse(), 2);
});

test('expireDead: a mid-launch reservation (claimed after the pass began) survives even with a dead pid', () => {
  const t = slots.acquire('scheduler:mid', { claimedAt: NOW + 5 });
  slots.stampPid(t, 4242);
  const out = slots.expireDead({ liveSlugs: new Set(), pidAlive: () => false, now: NOW, graceMs: GRACE });
  assert.deepEqual(out, []);
  assert.equal(slots.inUse(), 1);
});
