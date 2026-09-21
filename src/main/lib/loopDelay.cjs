'use strict';

/**
 * Event-loop delay probe for the main-process memory heartbeat. Wraps a
 * perf_hooks IntervalHistogram (injectable for tests): enable() at init,
 * snapshot() once per heartbeat returns the interval just ended in ms and
 * reset()s, disable() rides the heartbeat teardown. No timer of its own.
 */

const { monitorEventLoopDelay } = require('node:perf_hooks');

const LOOP_DELAY_RESOLUTION_MS = 20;
// A single beat whose worst loop delay exceeds this is a visible main-thread stall.
const LOOP_STALL_WARN_MS = 250;

const NS_PER_MS = 1e6;
const toMs = (ns) => Math.round(ns / NS_PER_MS * 10) / 10;

function createLoopDelayMonitor(createHistogram = monitorEventLoopDelay) {
  const h = createHistogram({ resolution: LOOP_DELAY_RESOLUTION_MS });
  return {
    enable() { h.enable(); },
    disable() { h.disable(); },
    /** Percentiles for the interval since the last snapshot; resets the histogram. */
    snapshot() {
      const out = {
        loopDelayP50Ms: toMs(h.percentile(50)),
        loopDelayP99Ms: toMs(h.percentile(99)),
        loopDelayMaxMs: toMs(h.max),
      };
      h.reset();
      return out;
    },
  };
}

/** Log level + message for a heartbeat given its loop-delay snapshot. */
function stallVerdict(snap) {
  return snap.loopDelayMaxMs > LOOP_STALL_WARN_MS
    ? { level: 'warn', message: 'main loop stall' }
    : null;
}

module.exports = { createLoopDelayMonitor, stallVerdict, LOOP_STALL_WARN_MS, LOOP_DELAY_RESOLUTION_MS };
