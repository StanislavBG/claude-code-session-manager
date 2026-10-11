/**
 * reservationExpiry.cjs — the single fail-CLOSED "is this reservation's owner
 * provably dead?" predicate shared by sessionSlots, quietMachineLease, the
 * investigation set and gitWorktree's accounting. A reservation is released
 * only on proof: no live row for its slug AND (a stamped pid that is dead, or
 * no pid ever stamped and claimedAt older than graceMs). Anything ambiguous
 * (live row, live pid, inside the grace window, claimed after the pass began)
 * is kept. Never signals a process.
 */
'use strict';

const { pidAlive } = require('./pidAlive.cjs');

const DEFAULT_GRACE_MS = 10 * 60 * 1000;

/**
 * @param {{ claimedAt: number, pid: number|null }} res
 * @param {{ live: boolean, pidAlive?: (pid:number)=>boolean, now: number, graceMs?: number }} ctx
 */
function isProvablyDead(res, { live, pidAlive: isAlive = pidAlive, now, graceMs = DEFAULT_GRACE_MS }) {
  if (live) return false;
  // Made after the pass began (i.e. this tick) — never expire it.
  if (!Number.isFinite(res.claimedAt) || res.claimedAt > now) return false;
  if (Number.isInteger(res.pid) && res.pid > 0) return !isAlive(res.pid);
  return now - res.claimedAt > graceMs;
}

module.exports = { isProvablyDead, DEFAULT_GRACE_MS };
