/**
 * otelSettings — persists OTEL telemetry export configuration.
 *
 * Storage: ~/.config/session-manager/otel.json
 * Shape: {
 *   enabled: boolean,
 *   endpoint: string,        // OTLP/HTTP traces endpoint
 *   headers: string,         // newline-separated "Key: Value" pairs
 *   serviceName: string,
 *   includeContent: boolean, // mirrors upstream OTEL_LOG_USER_PROMPTS — opt-in PII
 *   schemaVersion: 1
 * }
 *
 * Atomic write pattern (tmp + rename) mirrors voiceSettings.cjs.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const config = require('./config.cjs');

const SCHEMA_VERSION = 1;

const DEFAULTS = Object.freeze({
  enabled: false,
  endpoint: 'http://localhost:4318/v1/traces',
  headers: '',
  serviceName: 'session-manager',
  includeContent: false,
  schemaVersion: SCHEMA_VERSION,
});

function storePath() {
  return path.join(os.homedir(), '.config', 'session-manager', 'otel.json');
}

function isValid(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  if (typeof cfg.enabled !== 'boolean') return false;
  if (typeof cfg.endpoint !== 'string') return false;
  if (typeof cfg.headers !== 'string') return false;
  if (typeof cfg.serviceName !== 'string' || !cfg.serviceName.trim()) return false;
  if (typeof cfg.includeContent !== 'boolean') return false;
  return true;
}

function normalize(cfg) {
  return {
    enabled: !!cfg.enabled,
    endpoint: typeof cfg.endpoint === 'string' && cfg.endpoint.trim() ? cfg.endpoint.trim() : DEFAULTS.endpoint,
    headers: typeof cfg.headers === 'string' ? cfg.headers : '',
    serviceName: typeof cfg.serviceName === 'string' && cfg.serviceName.trim() ? cfg.serviceName.trim() : DEFAULTS.serviceName,
    includeContent: !!cfg.includeContent,
    schemaVersion: SCHEMA_VERSION,
  };
}

async function load() {
  try {
    const raw = await fsp.readFile(storePath(), 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      return normalize({ ...DEFAULTS, ...data });
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('[otelSettings] load failed:', e.message);
    }
  }
  return { ...DEFAULTS };
}

let writeQueue = Promise.resolve();
async function save(cfg) {
  if (!isValid(cfg)) throw new Error('Invalid OTEL config');
  const next = normalize(cfg);
  const run = async () => {
    await config.writeTextAtomic(storePath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    return next;
  };
  const tail = writeQueue.then(run, run);
  writeQueue = tail.catch(() => {});
  return tail;
}

/**
 * Parse "Key: Value\nKey2: Value2" → { Key: 'Value', Key2: 'Value2' }.
 * Empty / whitespace-only lines and lines without ':' are silently dropped.
 * Complexity: O(n) where n is the string length.
 */
function parseHeaders(text) {
  const out = {};
  if (typeof text !== 'string' || !text.trim()) return out;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

module.exports = {
  load,
  save,
  storePath,
  parseHeaders,
  isValid,
  DEFAULTS,
  SCHEMA_VERSION,
};
