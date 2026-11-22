// sessionSlots.cjs lanes, the held interactive slot, and the async waiter queue.
// vitest globals (test/beforeEach/afterEach) — same convention as sessionSlots.test.cjs.
const assert = require('node:assert');
const slots = require('../sessionSlots.cjs');

beforeEach(() => {
  slots.__resetForTests();
  process.env.SM_SESSION_SLOTS = '10';
});
afterEach(() => {
  slots.__resetForTests();
  delete process.env.SM_SESSION_SLOTS;
  vi.useRealTimers();
});

function fill(n, lane = 'job') {
  const out = [];
  for (let i = 0; i < n; i++) out.push(slots.acquire(`${lane}:${i}`, { lane }));
  return out;
}

test('acquire stores lane; unknown lane falls back to general', () => {
  slots.acquire('a', { lane: 'job' });
  slots.acquire('b', { lane: 'bogus' });
  slots.acquire('c');
  const lanes = slots.snapshot().holders.map((h) => h.lane);
  assert.deepEqual(lanes, ['job', 'general', 'general']);
  const snap = slots.snapshot();
  assert.deepEqual(snap.waiters, []);
  assert.equal(snap.reserve, 0);
});

test('reserve at cap 10: non-interactive stops at 9, interactive takes the 10th', () => {
  slots.setInteractiveReserve(true);
  assert.equal(slots.snapshot().reserve, 1);
  assert.equal(slots.jobCapacity(), 9);
  const toks = fill(9, 'job');
  assert.ok(toks.every(Boolean));
  assert.equal(slots.snapshot().holders.length, 9, 'held slot is arithmetic, not a placeholder holder');
  assert.equal(slots.acquire('job:x', { lane: 'job' }), null);
  assert.equal(slots.acquire('gen', { lane: 'general' }), null);
  assert.equal(slots.acquire('tb', { lane: 'task-batch' }), null);
  assert.equal(slots.availableFor('task-interactive'), 1);
  assert.ok(slots.acquire('ti', { lane: 'task-interactive' }));
  assert.equal(slots.acquire('ti2', { lane: 'task-interactive' }), null);
});

test('interactive holders do not consume the non-interactive budget', () => {
  slots.setInteractiveReserve(true);
  fill(3, 'task-interactive');
  assert.equal(slots.availableFor('job'), 7);
  assert.equal(slots.availableFor('task-interactive'), 7);
});

test('reserve at cap 1 behaves exactly as today', () => {
  process.env.SM_SESSION_SLOTS = '1';
  slots.setInteractiveReserve(true);
  assert.equal(slots.snapshot().reserve, 0);
  assert.equal(slots.jobCapacity(), 1);
  assert.ok(slots.acquire('j', { lane: 'job' }));
  assert.equal(slots.acquire('ti', { lane: 'task-interactive' }), null);
});

test('reserve off: full cap available to jobs', () => {
  assert.equal(slots.jobCapacity(), 10);
  assert.ok(fill(10).every(Boolean));
  assert.equal(slots.acquire('x', { lane: 'job' }), null);
});

test('a queued waiter takes a freed slot before a job acquire', async () => {
  process.env.SM_SESSION_SLOTS = '2';
  const [a] = fill(2, 'job');
  const p = slots.waitForSlot('task:1', { lane: 'task-batch', timeoutMs: 10_000 });
  assert.equal(slots.snapshot().waiters.length, 1);
  assert.equal(slots.availableFor('job'), 0);
  let seenByListener = null;
  const unsub = slots.subscribe(() => { seenByListener = slots.snapshot().waiters.length; });
  slots.release(a);
  unsub();
  assert.equal(seenByListener, 0, 'grant happens before listeners fire');
  const tok = await p;
  assert.ok(tok);
  assert.equal(slots.snapshot().holders.find((h) => h.owner === 'task:1').lane, 'task-batch');
  assert.equal(slots.acquire('job:late', { lane: 'job' }), null);
});

test('job acquire is refused while a waiter queues; general is not', () => {
  process.env.SM_SESSION_SLOTS = '3';
  slots.setInteractiveReserve(true);
  fill(2, 'job');
  // non-interactive budget = 2 -> batch waiter must queue though one slot is free
  const p = slots.waitForSlot('task:b', { lane: 'task-batch', timeoutMs: 10_000 });
  assert.equal(slots.snapshot().waiters.length, 1);
  slots.setInteractiveReserve(false);
  return p.then((tok) => {
    assert.ok(tok, 'turning the reserve off grants the waiter');
  });
});

test('general acquires are not blocked by waiters', () => {
  process.env.SM_SESSION_SLOTS = '3';
  slots.setInteractiveReserve(true);
  fill(1, 'job');
  slots.acquire('ti', { lane: 'task-interactive' });
  slots.acquire('ti2', { lane: 'task-interactive' });
  // pool full: waiter queues
  slots.waitForSlot('task:b', { lane: 'task-batch', timeoutMs: 10_000 });
  process.env.SM_SESSION_SLOTS = '5';
  // no grant trigger yet -> waiter still queued, general may still acquire
  assert.equal(slots.snapshot().waiters.length, 1);
  assert.equal(slots.availableFor('job'), 0);
  assert.ok(slots.availableFor('general') > 0);
  assert.ok(slots.acquire('chat:x', { lane: 'general' }));
  assert.equal(slots.acquire('job:y', { lane: 'job' }), null);
});

test('interactive waiter is granted before an earlier batch waiter', async () => {
  process.env.SM_SESSION_SLOTS = '2';
  const [a, b] = fill(2, 'job');
  const order = [];
  const pb = slots.waitForSlot('batch', { lane: 'task-batch', timeoutMs: 10_000 }).then((t) => { order.push('batch'); return t; });
  const pi = slots.waitForSlot('inter', { lane: 'task-interactive', timeoutMs: 10_000 }).then((t) => { order.push('inter'); return t; });
  slots.release(a);
  assert.deepEqual(slots.snapshot().waiters.map((w) => w.owner), ['batch']);
  slots.release(b);
  assert.deepEqual(slots.snapshot().waiters, []);
  assert.ok(await pi);
  assert.ok(await pb);
  assert.deepEqual(order, ['inter', 'batch']);
});

test('batch waiters are FIFO', async () => {
  process.env.SM_SESSION_SLOTS = '1';
  const [a] = fill(1, 'job');
  const p1 = slots.waitForSlot('b1', { lane: 'task-batch', timeoutMs: 10_000 });
  slots.waitForSlot('b2', { lane: 'task-batch', timeoutMs: 10_000 });
  slots.release(a);
  assert.ok(await p1);
  assert.deepEqual(slots.snapshot().waiters.map((w) => w.owner), ['b2']);
});

test('timeout resolves null and removes the waiter', async () => {
  vi.useFakeTimers();
  process.env.SM_SESSION_SLOTS = '1';
  fill(1, 'job');
  const p = slots.waitForSlot('t', { lane: 'task-batch', timeoutMs: 500 });
  assert.equal(slots.snapshot().waiters.length, 1);
  vi.advanceTimersByTime(501);
  assert.equal(await p, null);
  assert.equal(slots.snapshot().waiters.length, 0);
  assert.equal(slots.availableFor('job'), 0, 'pool still full');
});

test('abort resolves null and removes the waiter', async () => {
  process.env.SM_SESSION_SLOTS = '1';
  const [a] = fill(1, 'job');
  const ac = new AbortController();
  const p = slots.waitForSlot('t', { lane: 'task-interactive', timeoutMs: 10_000, signal: ac.signal });
  ac.abort();
  assert.equal(await p, null);
  assert.equal(slots.snapshot().waiters.length, 0);
  slots.release(a);
  assert.equal(slots.snapshot().holders.length, 0, 'aborted waiter never got a slot');
});

test('already-aborted signal resolves null', async () => {
  process.env.SM_SESSION_SLOTS = '0';
  const ac = new AbortController();
  ac.abort();
  assert.equal(await slots.waitForSlot('t', { lane: 'task-batch', signal: ac.signal }), null);
  assert.equal(slots.snapshot().waiters.length, 0);
});

test('waitForSlot grants immediately when a slot is free', async () => {
  const tok = await slots.waitForSlot('t', { lane: 'task-batch' });
  assert.ok(tok);
  assert.equal(slots.snapshot().holders[0].lane, 'task-batch');
});

test('waitForSlot rejects lanes other than task-batch/task-interactive', async () => {
  await assert.rejects(slots.waitForSlot('t', { lane: 'job' }), (e) => e.code === 'bad_lane');
});

test('51st waiter rejects with too_many_waiting', async () => {
  process.env.SM_SESSION_SLOTS = '0';
  for (let i = 0; i < 50; i++) slots.waitForSlot(`w${i}`, { lane: 'task-batch', timeoutMs: 60_000 });
  assert.equal(slots.snapshot().waiters.length, 50);
  await assert.rejects(slots.waitForSlot('w50', { lane: 'task-batch' }), (e) => e.code === 'too_many_waiting');
  assert.equal(slots.snapshot().waiters.length, 50);
});

test('expireDead grants a waiter', async () => {
  process.env.SM_SESSION_SLOTS = '1';
  slots.acquire('scheduler:gone', { lane: 'job', claimedAt: 0 });
  const p = slots.waitForSlot('t', { lane: 'task-batch', timeoutMs: 10_000 });
  const expired = slots.expireDead({ liveSlugs: new Set(), pidAlive: () => false, now: 10 * 60 * 60 * 1000 });
  assert.deepEqual(expired, ['scheduler:gone']);
  assert.ok(await p);
});

test('availableFor and jobCapacity', () => {
  slots.setInteractiveReserve(true);
  assert.equal(slots.jobCapacity(), 9);
  assert.equal(slots.availableFor('job'), 9);
  assert.equal(slots.availableFor('general'), 9);
  assert.equal(slots.availableFor('task-interactive'), 10);
  fill(4, 'job');
  assert.equal(slots.availableFor('job'), 5);
  assert.equal(slots.availableFor('task-interactive'), 6);
  slots.setInteractiveReserve(false);
  assert.equal(slots.jobCapacity(), 10);
  assert.equal(slots.availableFor('job'), 6);
});
