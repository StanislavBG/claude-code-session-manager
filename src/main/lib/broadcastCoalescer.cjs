'use strict';

/**
 * Trailing-edge debounce for a broadcast send. `schedule()` arms a timer on
 * the first call; further calls before it fires are no-ops — they do NOT
 * reset the timer (this is a fixed coalescing window, not an inactivity
 * debounce). When the timer fires, `getPayload()` is invoked fresh so the
 * sent payload reflects every mutation that happened during the window, not
 * just the one that armed it. `flush()` cancels any pending timer and sends
 * immediately, for callers where latency matters more than coalescing.
 */
function createBroadcastCoalescer({ delayMs, send, getPayload }) {
  let timer = null;

  async function fire() {
    timer = null;
    try {
      const payload = await getPayload();
      send(payload);
    } catch (e) {
      // Self-heals: the next schedule()/flush() call arms a fresh timer/send
      // since `timer` is already null. Log so a persistent getPayload()
      // failure (e.g. a corrupt queue.json) isn't silently invisible.
      console.error('[broadcastCoalescer] fire() failed', e?.message ?? e);
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { fire(); }, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const payload = await getPayload();
    send(payload);
  }

  return { schedule, flush };
}

module.exports = { createBroadcastCoalescer };
