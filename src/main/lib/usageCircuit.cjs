'use strict';

/**
 * usageCircuit.cjs — a breaker over the /api/oauth/usage meter (PRD ss-02).
 * Degraded mode is explicit, never a silent 0: repeated failures open the
 * circuit with jittered backoff; degradedBudget() carries forward the last
 * known-good BINDING window's utilization (never 0), pinning to 100 on a
 * fresh executor-observed 429 and capping concurrency at 2. Pure Node.
 *
 * Kill switches (read live from process.env, so a test/operator can flip
 * them without restarting anything that already holds a circuit instance):
 *   SM_USAGE_CIRCUIT=0      — bypasses the breaker entirely: state() always
 *                             reports 'closed' and recordFailure() never
 *                             opens it. Escape hatch if the breaker itself
 *                             is ever suspected of wedging dispatch.
 *   SM_USAGE_DEGRADED_CAP=n — overrides degradedBudget()'s concurrencyCap
 *                             outright (bypasses the normal min(cap, 2)),
 *                             for an operator who needs a different ceiling
 *                             while the meter is degraded.
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

/** Flat sibling window that mirrors a `limits[]` entry's `kind`, for resets_at backfill. */
const FLAT_WINDOW_BY_KIND = { session: 'five_hour', weekly_all: 'seven_day' };

/** An entry's utilization: real `percent`, else the flat-shape `utilization`. */
function entryPercent(l) {
  return Number.isFinite(l.percent) ? l.percent : l.utilization;
}

/**
 * Which window is actually binding dispatch. The real /api/oauth/usage
 * `limits[]` entries carry `kind` / `group` / `percent` / `severity` /
 * `resets_at` / `scope` / `is_active` (percent is 0-100, may exceed 100).
 * Only UNSCOPED entries (`scope == null`) are candidates — a scoped entry
 * (e.g. `weekly_scoped` for one model) does not bind dispatch generally. Among
 * them the HIGHEST finite percent wins ("binding" = closest to blocking us);
 * `is_active` only breaks ties, because the API sets it on group precedence
 * and trusting it alone would pick weekly_all 64 over session 95. With no
 * usable unscoped entry, falls back to the flat `five_hour`. Pure, no I/O.
 */
function bindingWindow(payload) {
  if (payload && Array.isArray(payload.limits)) {
    let best = null;
    let bestPct = -Infinity;
    for (const l of payload.limits) {
      if (!l || l.scope != null) continue;
      const pct = entryPercent(l);
      if (!Number.isFinite(pct)) continue;
      if (pct > bestPct || (pct === bestPct && l.is_active === true && !(best && best.is_active === true))) {
        best = l;
        bestPct = pct;
      }
    }
    if (best) {
      const flat = payload[FLAT_WINDOW_BY_KIND[best.kind]];
      return {
        name: best.kind || best.type || best.name || 'unknown',
        utilization: bestPct,
        resets_at: best.resets_at ?? (flat ? flat.resets_at ?? null : null),
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
 * SM_USAGE_DEGRADED_CAP=<n> overrides the normal min(configuredCap, 2)
 * ceiling outright — an operator escape hatch, not a default path. Falls
 * through to the normal min(cap, 2) rule when unset/non-positive.
 */
function degradedConcurrencyCap(configuredCap) {
  const override = Number(process.env.SM_USAGE_DEGRADED_CAP);
  if (Number.isFinite(override) && override > 0) return override;
  const cap = Number.isFinite(configuredCap) ? configuredCap : 2;
  return Math.min(cap, 2);
}

/**
 * Conservative budget to run on while the meter is down. utilization is
 * carried forward from the last known-good BINDING window — never 0, which
 * would read as "plenty of headroom" instead of "we don't know." A fresh
 * executor-observed 429 (its own window not yet passed) pins utilization to
 * 100 regardless of the stale cached value. concurrencyCap never exceeds 2
 * (or SM_USAGE_DEGRADED_CAP, if set).
 */
function degradedBudget(lastGoodPayload, executorEvidence = {}) {
  const window = bindingWindow(lastGoodPayload);
  let utilization = Number.isFinite(window.utilization) && window.utilization > 0
    ? window.utilization
    : 100;

  const concurrencyCap = degradedConcurrencyCap(executorEvidence.configuredCap);

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

/** SM_USAGE_CIRCUIT=0 (or 'false') bypasses the breaker entirely. */
function breakerEnabled() {
  const v = process.env.SM_USAGE_CIRCUIT;
  return v == null || v === '' || (v !== '0' && String(v).toLowerCase() !== 'false');
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
  // ms timestamp the circuit most recently transitioned closed -> open; kept
  // through half_open <-> open cycles of the SAME streak (a failed probe
  // re-arms the timer but the meter has been down continuously since this
  // timestamp), cleared only by recordSuccess. Feeds health.cjs's
  // GREEN/YELLOW/RED ladder (open duration), not just a failure count.
  let openedAtMs = null;

  function scheduleNextProbe() {
    const intervalMs = backoffWithJitter(backoffBaseMs);
    backoffBaseMs = doubledBase(backoffBaseMs);
    nextProbeAtMs = now() + intervalMs;
  }

  function state() {
    if (!breakerEnabled()) return 'closed';
    if (currentState === 'open' && !probeInFlight && now() >= nextProbeAtMs) {
      currentState = 'half_open';
      probeInFlight = true;
    }
    return currentState;
  }

  function recordFailure(kind) { // eslint-disable-line no-unused-vars
    consecutiveFailures += 1;
    if (!breakerEnabled()) return;
    if (currentState === 'half_open') {
      probeInFlight = false;
      currentState = 'open';
      scheduleNextProbe();
      return;
    }
    if (currentState === 'closed' && consecutiveFailures >= 3) {
      currentState = 'open';
      openedAtMs = now();
      scheduleNextProbe();
    }
  }

  function recordSuccess(payload) { // eslint-disable-line no-unused-vars
    consecutiveFailures = 0;
    probeInFlight = false;
    backoffBaseMs = 0;
    currentState = 'closed';
    openedAtMs = null;
  }

  /** ms timestamp this streak opened, or null while closed. */
  function openedAt() {
    return currentState === 'open' || currentState === 'half_open' ? openedAtMs : null;
  }

  function getConsecutiveFailures() {
    return consecutiveFailures;
  }

  return { recordSuccess, recordFailure, state, openedAt, getConsecutiveFailures };
}

module.exports = {
  createUsageCircuit,
  backoffWithJitter,
  isResetFresh,
  bindingWindow,
  degradedBudget,
  degradedConcurrencyCap,
  singleFlight,
};
