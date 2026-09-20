'use strict';

/**
 * updateCheck.cjs — bounded, offline-safe, opt-out "is a newer build published?" probe.
 *
 * getUpdateStatus() → { current, latest, behind }. Never throws/rejects; any failure
 * (offline, DNS, non-200, bad JSON, timeout) → { current, latest: null, behind: false }.
 * The request is a bare GET (no headers/cookies/query/body) so it carries nothing that
 * identifies the user or machine. Disabled by SM_UPDATE_CHECK=0 or E2E mode (SM_E2E=1).
 */

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3000;
const CACHE_FILE = 'update-check.json';

/** Plain GET → parsed JSON. Rejects on non-200, bad JSON, or timeout. */
function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 65536) req.destroy(new Error('response too large'));
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function parseTriple(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True iff `current` is strictly older than `latest` (numeric major.minor.patch). */
function isBehind(current, latest) {
  const a = parseTriple(current);
  const b = parseTriple(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function readCache(file, now) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c && typeof c.latest === 'string' && typeof c.checkedAt === 'number'
      && now - c.checkedAt >= 0 && now - c.checkedAt < CACHE_TTL_MS) return c.latest;
  } catch { /* missing/corrupt cache = miss */ }
  return null;
}

function defaultPackageName() {
  return require(path.join(__dirname, '..', '..', '..', 'package.json')).name;
}

async function getUpdateStatus({ deps } = {}) {
  const d = deps || {};
  let current = '';
  try {
    const app = d.app || require('electron').app;
    current = app.getVersion();
    const env = d.env || process.env;
    if (env.SM_UPDATE_CHECK === '0' || env.SM_E2E === '1') return { current, latest: null, behind: false };

    const now = (d.now || Date.now)();
    const file = path.join(app.getPath('userData'), CACHE_FILE);
    let latest = readCache(file, now);
    if (latest == null) {
      const name = (d.packageName || defaultPackageName)();
      const url = `https://registry.npmjs.org/-/package/${name}/dist-tags`;
      const tags = await (d.fetchJson || httpGetJson)(url, REQUEST_TIMEOUT_MS);
      latest = tags && typeof tags.latest === 'string' ? tags.latest : null;
      if (latest == null) return { current, latest: null, behind: false };
      try {
        await (d.writeJson || require('../config.cjs').writeJson)(file, { checkedAt: now, latest });
      } catch { /* cache is best-effort */ }
    }
    return { current, latest, behind: isBehind(current, latest) };
  } catch {
    return { current, latest: null, behind: false };
  }
}

module.exports = { getUpdateStatus, isBehind };
