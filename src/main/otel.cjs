/**
 * otel — mirrors transcripts.cjs classified events as OpenTelemetry spans.
 *
 * Spans are 0-duration "events": one span per classified transcript EVENT
 * (a single JSONL line can classify to several events — e.g. a usage rollup
 * alongside real content, or several tool calls in one assistant turn),
 * named `transcript.<kind>`, with structural attributes only. Tool inputs,
 * plan text, and agent prompts are excluded unless `includeContent` is on
 * (matches upstream OTEL_LOG_USER_PROMPTS opt-in).
 *
 * Spans are POSTed as OTLP/HTTP JSON by lib/otlpTraceExporter.cjs (zero
 * dependencies). recordSpan() only queues; the exporter batches/sends on its
 * own unref()'d timer, so we never block the transcript flush. The app must
 * keep working without telemetry: a failed export is surfaced, never thrown.
 */

const otelSettings = require('./otelSettings.cjs');
const { createOtlpTraceExporter } = require('./lib/otlpTraceExporter.cjs');

let exporter = null;
let enabled = false;
let includeContent = false;
let lastError = null;
let initialized = false;

/**
 * Tear down any existing exporter. Best-effort — flushes pending spans on a
 * 2s ceiling so a wedged exporter doesn't block app shutdown / config reload.
 */
async function shutdown() {
  if (!exporter) {
    enabled = false;
    return;
  }
  const e = exporter;
  exporter = null;
  enabled = false;
  try {
    await Promise.race([
      e.shutdown(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  } catch (err) {
    console.warn('[otel] shutdown failed:', err?.message);
  }
}

/**
 * Configure the exporter. Tears down any prior exporter first so a
 * settings change reliably re-points at the new endpoint.
 *
 * Returns { ok, error?: string } — the renderer surfaces `error` in the UI.
 */
async function init({ endpoint, headers, serviceName, includeContent: ic } = {}) {
  await shutdown();
  initialized = true;

  try {
    exporter = createOtlpTraceExporter({
      url: String(endpoint || 'http://localhost:4318/v1/traces'),
      headers: typeof headers === 'object' && headers ? headers : {},
      serviceName: String(serviceName || 'session-manager'),
      scopeName: 'session-manager-transcripts',
    });
    includeContent = !!ic;
    enabled = true;
    lastError = null;
    return { ok: true };
  } catch (err) {
    lastError = err?.message || String(err);
    enabled = false;
    return { ok: false, error: lastError };
  }
}

/**
 * Apply current persisted config: shut down if disabled, init if enabled.
 * Called on app boot and after every settings save.
 */
async function applyConfig(cfg) {
  if (!cfg || !cfg.enabled) {
    await shutdown();
    return { ok: true };
  }
  return await init({
    endpoint: cfg.endpoint,
    headers: otelSettings.parseHeaders(cfg.headers),
    serviceName: cfg.serviceName,
    includeContent: cfg.includeContent,
  });
}

/**
 * Build the kind-specific attribute subset. Keep PII fields gated behind
 * `includeContent`. Truncate any free-form string at 4096 chars to bound the
 * span payload — most exporters reject spans larger than ~64KiB.
 */
function attrsFor(kind, data) {
  const cap = (s) => (typeof s === 'string' ? s.slice(0, 4096) : s);
  switch (kind) {
    case 'tool_use': {
      const a = {
        'tool.name': data?.name,
        'tool.id': data?.id,
      };
      if (includeContent && data?.input != null) {
        try { a['tool.input'] = cap(JSON.stringify(data.input)); } catch { /* */ }
      }
      return a;
    }
    case 'todo_write': {
      const todos = Array.isArray(data) ? data : [];
      let completed = 0, inProgress = 0;
      for (const t of todos) {
        if (t?.status === 'completed') completed++;
        else if (t?.status === 'in_progress') inProgress++;
      }
      return {
        'todo.count': todos.length,
        'todo.completed': completed,
        'todo.in_progress': inProgress,
      };
    }
    case 'plan': {
      const text = typeof data?.plan === 'string' ? data.plan : (typeof data === 'string' ? data : '');
      const a = { 'plan.chars': text.length };
      if (includeContent && text) a['plan.text'] = cap(text);
      return a;
    }
    case 'usage': {
      return {
        'usage.input_tokens': Number(data?.input_tokens || 0),
        'usage.output_tokens': Number(data?.output_tokens || 0),
        'usage.cache_creation_input_tokens': Number(data?.cache_creation_input_tokens || 0),
        'usage.cache_read_input_tokens': Number(data?.cache_read_input_tokens || 0),
      };
    }
    case 'agent_spawn': {
      const a = {
        'agent.subtype': data?.subagent_type,
        'agent.description': data?.description, // task description is structural metadata
      };
      if (includeContent && typeof data?.prompt === 'string') {
        a['agent.prompt'] = cap(data.prompt);
      }
      return a;
    }
    default:
      return {};
  }
}

/**
 * Drop attributes whose value is undefined/null so the exporter doesn't
 * complain about unsupported attribute types.
 */
function pruneAttrs(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Emit a 0-duration span for one classified transcript event.
 * Synchronous + non-blocking: the exporter handles network I/O
 * on its own schedule.
 */
function recordTranscriptEvent({ tabId, tabCwd, kind, data, ts }) {
  if (!enabled || !exporter) return;
  try {
    const startTime = typeof ts === 'number' ? ts : Date.now();
    const attrs = pruneAttrs({
      'tab.id': tabId,
      'tab.cwd': tabCwd,
      kind,
      ...attrsFor(kind, data),
    });
    exporter.recordSpan({ name: `transcript.${kind}`, timeMs: startTime, attributes: attrs });
  } catch (err) {
    // A failure here must never break transcript ingestion. Log once-ish.
    if (!recordTranscriptEvent._warned) {
      recordTranscriptEvent._warned = true;
      console.warn('[otel] recordTranscriptEvent failed:', err?.message);
    }
  }
}

function status() {
  return {
    enabled,
    initialized,
    error: lastError,
    includeContent,
  };
}

module.exports = {
  init,
  applyConfig,
  shutdown,
  recordTranscriptEvent,
  status,
};
