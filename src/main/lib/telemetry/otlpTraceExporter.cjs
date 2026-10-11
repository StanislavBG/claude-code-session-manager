/**
 * otlpTraceExporter — zero-dependency batching exporter that POSTs 0-duration
 * spans to an OTLP/HTTP endpoint as JSON (ExportTraceServiceRequest).
 *
 * Replaces the @opentelemetry/* SDK for the one thing otel.cjs does: emit
 * "event" spans. recordSpan() only queues (no I/O, never throws); a timer
 * unref()'d so it can't hold the process open drains the queue in batches.
 * A failed POST drops that batch and is surfaced via stats() — the app must
 * keep working without telemetry. Field names mirror otlp-transformer's JSON.
 */

const crypto = require('node:crypto');

function toAnyValue(v) {
  switch (typeof v) {
    case 'string': return { stringValue: v };
    case 'boolean': return { boolValue: v };
    case 'bigint': return { intValue: v.toString() };
    case 'number':
      if (!Number.isFinite(v)) return { stringValue: String(v) };
      return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
    default:
      try { return { stringValue: JSON.stringify(v) ?? String(v) }; } catch { return { stringValue: String(v) }; }
  }
}

function toAttributes(obj) {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  for (const [key, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    out.push({ key, value: toAnyValue(v) });
  }
  return out;
}

function createOtlpTraceExporter({
  url,
  headers,
  serviceName,
  scopeName,
  maxQueue = 2048,
  maxBatch = 512,
  flushIntervalMs = 5000,
  timeoutMs = 10000,
} = {}) {
  let queue = [];
  let timer = null;
  let closed = false;
  let inFlight = Promise.resolve();
  const counts = { exported: 0, dropped: 0, failed: 0, lastError: null };

  function ensureTimer() {
    if (timer || closed) return;
    timer = setInterval(() => { flush(); }, flushIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function recordSpan({ name, timeMs, attributes } = {}) {
    try {
      if (closed) return;
      const ms = typeof timeMs === 'number' && Number.isFinite(timeMs) ? timeMs : Date.now();
      const nanos = (BigInt(Math.round(ms)) * 1000000n).toString();
      queue.push({
        traceId: crypto.randomBytes(16).toString('hex'),
        spanId: crypto.randomBytes(8).toString('hex'),
        name: String(name),
        kind: 1,
        startTimeUnixNano: nanos,
        endTimeUnixNano: nanos,
        attributes: toAttributes(attributes),
      });
      if (queue.length > maxQueue) {
        const over = queue.length - maxQueue;
        queue.splice(0, over);
        counts.dropped += over;
      }
      ensureTimer();
    } catch (err) {
      counts.lastError = err?.message || String(err);
    }
  }

  async function post(spans) {
    const body = JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: String(serviceName) } }] },
        scopeSpans: [{ scope: { name: String(scopeName) }, spans }],
      }],
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...(headers || {}), 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    try { await res.arrayBuffer(); } catch { /* body drain is best-effort */ }
    if (!res.ok) throw new Error(`OTLP endpoint responded ${res.status}`);
  }

  async function drain() {
    while (queue.length > 0) {
      const batch = queue.splice(0, maxBatch);
      try {
        await post(batch);
        counts.exported += batch.length;
        counts.lastError = null;
      } catch (err) {
        counts.failed += 1;
        counts.lastError = err?.message || String(err);
        return; // drop this batch; the next tick retries whatever is left
      }
    }
  }

  function flush() {
    const next = inFlight.then(drain, drain);
    inFlight = next.catch(() => {});
    return next.catch(() => {});
  }

  async function shutdown() {
    closed = true;
    if (timer) { clearInterval(timer); timer = null; }
    let guard;
    await Promise.race([
      flush(),
      new Promise((resolve) => { guard = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(guard);
    queue = [];
  }

  function stats() {
    return {
      queued: queue.length,
      exported: counts.exported,
      dropped: counts.dropped,
      failed: counts.failed,
      lastError: counts.lastError,
    };
  }

  return { recordSpan, flush, shutdown, stats };
}

module.exports = { createOtlpTraceExporter };
