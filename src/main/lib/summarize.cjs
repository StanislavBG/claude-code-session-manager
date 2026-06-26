'use strict';

/**
 * summarize.cjs — shared Haiku summarizer for completed assistant turns.
 *
 * Single source of truth for the Anthropic summarization call. Used by:
 *   - exchanges.cjs (records durable per-exchange summaries)
 *   - webRemote.cjs (mobile summary push — refactored to import from here)
 *
 * Degrade contracts (never throw — always return a record):
 *   no API key → { summary: text.slice(0,600), model:'raw', degraded:'no_api_key' }
 *   API error  → { summary: text.slice(0,600), model:'raw', degraded:'api_error' }
 *   success    → { summary: string, model: 'claude-haiku-4-5' }
 */

const https = require('node:https');

const SUMMARY_MODEL = 'claude-haiku-4-5';
const SUMMARY_MAX_INPUT_CHARS = 24_000;
const SUMMARY_SYSTEM =
  'Summarize this Claude Code assistant turn for a phone screen in 2 sentences max, ' +
  'followed by an optional list of up to 3 short action items. Plain text only — no ' +
  'markdown headers, no code blocks. Lead with what was done or decided.';

let _anthropicKeyCache = null; // memoized found key (string); null = re-resolve

/**
 * Resolve the Anthropic API key: env → web-remote.json config → null.
 * Only a found key is cached; absent re-resolves each call so adding the key
 * later takes effect without a restart.
 */
async function resolveAnthropicKey() {
  if (_anthropicKeyCache) return _anthropicKeyCache;
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv && fromEnv.trim()) {
    _anthropicKeyCache = fromEnv.trim();
    return _anthropicKeyCache;
  }
  try {
    const nodePath = require('node:path');
    const nodeOs = require('node:os');
    const nodeFs = require('node:fs/promises');
    const cfgPath = nodePath.join(nodeOs.homedir(), '.claude', 'session-manager', 'web-remote.json');
    const raw = await nodeFs.readFile(cfgPath, 'utf8');
    const cfg = JSON.parse(raw);
    const k = cfg && cfg.anthropicApiKey;
    if (typeof k === 'string' && k.trim()) {
      _anthropicKeyCache = k.trim();
      return _anthropicKeyCache;
    }
  } catch { /* fall through */ }
  return null;
}

/** POST to the Anthropic Messages API; returns the first text block, or throws. */
function _callApi(apiKey, text) {
  const body = JSON.stringify({
    model: SUMMARY_MODEL,
    max_tokens: 320,
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: text.slice(0, SUMMARY_MAX_INPUT_CHARS) }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 20_000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`anthropic HTTP ${res.statusCode}`));
        }
        try {
          const json = JSON.parse(data);
          const block = Array.isArray(json.content) ? json.content.find((b) => b.type === 'text') : null;
          if (!block?.text) return reject(new Error('no text in response'));
          resolve(block.text.trim());
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('anthropic request timed out')));
    req.end(body);
  });
}

/**
 * Summarize `text` via Haiku. Never throws — degrades to a raw slice on any
 * failure so callers always get a usable record.
 *
 * @param {string} text
 * @returns {Promise<{ summary: string, model: string, degraded?: string }>}
 */
async function summarize(text) {
  const apiKey = await resolveAnthropicKey();
  if (!apiKey) {
    return { summary: text.slice(0, 600), model: 'raw', degraded: 'no_api_key' };
  }
  try {
    const summary = await _callApi(apiKey, text);
    return { summary, model: SUMMARY_MODEL };
  } catch {
    return { summary: text.slice(0, 600), model: 'raw', degraded: 'api_error' };
  }
}

module.exports = { summarize, SUMMARY_MODEL, resolveAnthropicKey, _callApi };
