/**
 * sessionSlots.cjs — the Session-Manager-owned machine-wide `claude -p`
 * concurrency pool (2026-07-31 domain-model decision).
 *
 * Caps and limits belong to Session-Manager, not to any one consumer: the
 * scheduler and chatRunner previously each enforced a private cap (3 and 2),
 * which combined could exceed the machine's real budget — the exact shape of
 * the 2026-06-10 five-parallel-`claude -p` OOM. Now every subsystem that
 * wants to launch a `claude -p` process REQUESTS a slot here first and
 * releases it when the process settles. There is one pool, sized to the
 * machine (default 3 — CLAUDE.md "Avoid" cap; SM_SESSION_SLOTS overrides,
 * clamped to [1, 3]).
 *
 * Consumers keep their own scheduling policy (FIFO lanes, batch picking,
 * memory gates); this module only answers "may one more process start right
 * now?". Plain Node, no Electron deps, process-local state — all consumers
 * live in the one Electron main process, which is exactly why it can be the
 * arbiter.
 */
'use strict';

const crypto = require('node:crypto');

function totalSlots() {
  const parsed = parseInt(process.env.SM_SESSION_SLOTS || '3', 10);
  return Math.min(3, Math.max(1, Number.isFinite(parsed) ? parsed : 3));
}

// token → { owner, at }
const holders = new Map();

function inUse() {
  return holders.size;
}

function available() {
  return Math.max(0, totalSlots() - holders.size);
}

/**
 * acquire(owner) → token string, or null when the pool is exhausted.
 * `owner` is a diagnostic label ("scheduler:<slug>", "chat:<tabId>") shown in
 * snapshot() so a stuck holder is attributable.
 */
function acquire(owner) {
  if (holders.size >= totalSlots()) return null;
  const token = crypto.randomUUID();
  holders.set(token, { owner: String(owner || 'unknown'), at: new Date().toISOString() });
  return token;
}

// Release listeners: each consumer registers its own "a slot freed — try to
// start work" pump so a scheduler release wakes the chat lane and vice versa.
const listeners = new Set();
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** release(token) — idempotent; releasing an unknown/already-released token is a no-op. */
function release(token) {
  const had = holders.delete(token);
  if (had) {
    for (const fn of listeners) {
      try { fn(); } catch { /* a consumer's pump error is its own problem */ }
    }
  }
  return had;
}

/** Diagnostic view for status surfaces and tests. */
function snapshot() {
  return {
    total: totalSlots(),
    inUse: holders.size,
    holders: [...holders.values()],
  };
}

/** Test hook: drop all held slots. */
function __resetForTests() {
  holders.clear();
}

module.exports = { totalSlots, inUse, available, acquire, release, subscribe, snapshot, __resetForTests };
