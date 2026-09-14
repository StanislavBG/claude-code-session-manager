'use strict';

/**
 * usageCircuit.cjs — a breaker over the /api/oauth/usage meter (PRD ss-02).
 * Degraded mode is explicit, never a silent 0: repeated failures open the
 * circuit with jittered backoff; degradedBudget() carries forward the last
 * known-good BINDING window's utilization (never 0), pinning to 100 on a
 * fresh executor-observed 429 and capping concurrency at 2. Pure Node.
 */

const FLOOR_MS = 30_000;
const CAP_MS = 8 * 60 * 1000;

/** Doubles from FLOOR_MS, capped at CAP_MS. 0/falsy prevMs starts at the floor. */
function doubledBase(prevMs) {
  return prevMs > 0 ? Math.min(prevMs * 2, CAP_MS) : FLOOR_MS;
}

/**
 * Next backoff interval: doubles `prevMs` (floor FLOOR_MS, cap CAP_MS), then
 * jitters by 0.5 + rand()*0.5 so concurrent instances don't retry in lockstep.
 */
function backoffWithJitter(prevMs) {
  const base = doubledBase(prevMs);
  return base * (0.5 + Math.random() * 0.5);
}

/**
 * A cached reset timestamp is fresh only if it's strictly in the future
 * relative to `now` — null/unparseable/at-or-before-now all read as stale,
 * since a passed reset no longer describes a live window.
 */
function isResetFresh(iso, now) {
  if (!iso) return false;
  const resetMs = Date.parse(iso);
  if (!Number.isFinite(resetMs)) return false;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) return false;
  return resetMs > nowMs;
}

/**
 * Which window is actually binding dispatch. Prefers `payload.limits[]`'s
 * `is_active` entry (the richer per-window shape); falls back to the flat
 * `five_hour` field when `limits[]` is absent, matching usage.cjs's shape.
 */
function bindingWindow(payload) {
  if (payload && Array.isArray(payload.limits) && payload.limits.length) {
    const active = payload.limits.find((l) => l && l.is_active);
    if (active) {
      return {
        name: active.type || active.name || 'unknown',
        utilization: active.utilization,
        resets_at: active.resets_at ?? null,
      };
    }
  }
  const fh = payload && payload.five_hour;
  return {
    name: 'five_hour',
    utilization: fh ? fh.utilization : undefined,
    resets_at: fh ? fh.resets_at : null,
  };
}

/**
 * Conservative budget to run on while the meter is down. utilization is
 * carried forward from the last known-good BINDING window — never 0, which
 * would read as "plenty of headroom" instead of "we don't know." A fresh
 * executor-observed 429 (its own window not yet passed) pins utilization to
 * 100 regardless of the stale cached value. concurrencyCap never exceeds 2.
 */
function degradedBudget(lastGoodPayload, executorEvidence = {}) {
  const window = bindingWindow(lastGoodPayload);
  let utilization = Number.isFinite(window.utilization) && window.utilization > 0
    ? window.utilization
    : 100;

  const configuredCap = Number.isFinite(executorEvidence.configuredCap)
    ? executorEvidence.configuredCap
    : 2;
  const concurrencyCap = Math.min(configuredCap, 2);

  if (executorEvidence.observed429 && isResetFresh(executorEvidence.resetsAt, executorEvidence.now)) {
    utilization = 100;
  }

  return { utilization, concurrencyCap };
}

/** Wraps `fn` so concurrent callers awaiting an in-flight call share one promise. */
function singleFlight(fn) {
  let inFlight = null;
  return function singleFlightWrapped(...args) {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve(fn(...args)).finally(() => { inFlight = null; });
    return inFlight;
  };
}

/**
 * Breaker state machine over the meter: closed -> open after 3 consecutive
 * failures; open allows exactly one probe per backoff interval (half_open);
 * a successful probe closes the circuit and resets backoff, a failed probe
 * reopens it with backoff doubled.
 */
function createUsageCircuit({ now = () => Date.now() } = {}) {
  let consecutiveFailures = 0;
  let currentState = 'closed';
  let backoffBaseMs = 0;
  let nextProbeAtMs = 0;
  let probeInFlight = false;

  function scheduleNextProbe() {
    const intervalMs = backoffWithJitter(backoffBaseMs);
    backoffBaseMs = doubledBase(backoffBaseMs);
    nextProbeAtMs = now() + intervalMs;
  }

  function state() {
    if (currentState === 'open' && !probeInFlight && now() >= nextProbeAtMs) {
      currentState = 'half_open';
      probeInFlight = true;
    }
    return currentState;
  }

  function recordFailure(kind) { // eslint-disable-line no-unused-vars
    consecutiveFailures += 1;
    if (currentState === 'half_open') {
      probeInFlight = false;
      currentState = 'open';
      scheduleNextProbe();
      return;
    }
    if (currentState === 'closed' && consecutiveFailures >= 3) {
      currentState = 'open';
      scheduleNextProbe();
    }
  }

  function recordSuccess(payload) { // eslint-disable-line no-unused-vars
    consecutiveFailures = 0;
    probeInFlight = false;
    backoffBaseMs = 0;
    currentState = 'closed';
  }

  return { recordSuccess, recordFailure, state };
}

module.exports = {
  createUsageCircuit,
  backoffWithJitter,
  isResetFresh,
  bindingWindow,
  degradedBudget,
  singleFlight,
};
