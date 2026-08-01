/**
 * sessionSlots.cjs — the Session-Manager-owned machine-wide `claude -p`
 * concurrency pool (2026-07-31 domain-model decision; made user-configurable
 * 2026-08-01).
 *
 * Caps and limits belong to Session-Manager, not to any one consumer: the
 * scheduler and chatRunner previously each enforced a private cap (3 and 2),
 * which combined could exceed the machine's real budget — the exact shape of
 * the 2026-06-10 five-parallel-`claude -p` OOM. Now every subsystem that
 * wants to launch a `claude -p` process REQUESTS a slot here first and
 * releases it when the process settles. There is one pool, sized to the
 * machine (default 5, user-adjustable [0, 10] from the Home tab; 0 pauses new
 * launches without touching already-running processes — SM_SESSION_SLOTS
 * still overrides everything for scripted/CI use, clamped to the same
 * [0, 10] range).
 *
 * Consumers keep their own scheduling policy (FIFO lanes, batch picking,
 * memory gates); this module only answers "may one more process start right
 * now?". Plain Node, no Electron deps, process-local state (the persisted cap
 * is the one exception — a tiny standalone JSON file, not routed through any
 * other module's config store) — all consumers live in the one Electron main
 * process, which is exactly why it can be the arbiter.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MIN_SLOTS = 0;
const MAX_SLOTS = 10;
const DEFAULT_SLOTS = 5;

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'session-slots-config.json');

function clamp(n) {
  return Math.min(MAX_SLOTS, Math.max(MIN_SLOTS, n));
}

function readPersistedCap() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const cap = Number(parsed.cap);
    return Number.isFinite(cap) ? clamp(Math.trunc(cap)) : DEFAULT_SLOTS;
  } catch {
    return DEFAULT_SLOTS;
  }
}

/** Persist a new cap to disk (tmp + rename). Throws on an out-of-range value. */
function setCap(cap) {
  const n = Number(cap);
  if (!Number.isFinite(n) || Math.trunc(n) !== n || n < MIN_SLOTS || n > MAX_SLOTS) {
    throw new Error(`sessionSlots.setCap: cap must be an integer in [${MIN_SLOTS}, ${MAX_SLOTS}]`);
  }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ cap: n }, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
  for (const fn of listeners) {
    try { fn(); } catch { /* a consumer's pump error is its own problem */ }
  }
  return n;
}

function totalSlots() {
  if (process.env.SM_SESSION_SLOTS !== undefined) {
    const parsed = parseInt(process.env.SM_SESSION_SLOTS, 10);
    return Number.isFinite(parsed) ? clamp(parsed) : DEFAULT_SLOTS;
  }
  return readPersistedCap();
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
// Also fired when the cap itself increases (setCap), for the same reason.
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
    min: MIN_SLOTS,
    max: MAX_SLOTS,
    default: DEFAULT_SLOTS,
    envOverride: process.env.SM_SESSION_SLOTS !== undefined,
  };
}

/** Test hook: drop all held slots. */
function __resetForTests() {
  holders.clear();
}

module.exports = {
  MIN_SLOTS,
  MAX_SLOTS,
  DEFAULT_SLOTS,
  totalSlots,
  setCap,
  inUse,
  available,
  acquire,
  release,
  subscribe,
  snapshot,
  __resetForTests,
};
