'use strict';

// The one map of MCP server definitions a headless job, Task or geared chat
// turn may load. Reads the same scopes the CLI does (user < project < local)
// and refuses credential-bearing entries so no secret reaches a job's argv.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const seed = require('../../seedSchedulerMcp.cjs');
const { SECRET_KEY_RE } = require('../process/cleanEnv.cjs');

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlain(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Plain-object entries of a plain-object mcpServers map; else {}. */
function serversOf(map) {
  const out = {};
  if (!isPlain(map)) return out;
  for (const name of Object.keys(map)) {
    if (has(map, name) && isPlain(map[name])) out[name] = map[name];
  }
  return out;
}

const SECRET_FLAG_RE = /^--(api-key|apikey|token|access-token|secret|password|auth|pat)(=|$)/i;
const EXTRA_KEY_RE = /(^|_)(PAT|CREDENTIALS?|PRIVATE_KEY)$/i;
const QUERY_KEY_RE = /(token|key|secret|password|sig|signature|auth)/i;
const USERINFO_RE = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i;
const HINT = 'move the secret to a vault ref (environment profile) or run it outside the job';

function secretKey(key) {
  return SECRET_KEY_RE.test(key) || EXTRA_KEY_RE.test(key) || /authorization/i.test(key);
}

function argsReason(name, args) {
  if (!Array.isArray(args)) return null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') continue;
    const m = SECRET_FLAG_RE.exec(a);
    if (m) {
      const flag = `--${m[1].toLowerCase()}`;
      if (m[2] === '=' || i + 1 < args.length) {
        return `${name} carries secret flag ${flag} in its args; ${HINT}`;
      }
    }
    if (USERINFO_RE.test(a)) {
      return `${name} carries URL userinfo in its args; ${HINT}`;
    }
  }
  return null;
}

function urlReason(name, url) {
  if (typeof url !== 'string') return null;
  if (USERINFO_RE.test(url)) return `${name} carries URL userinfo in its url; ${HINT}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return `${name} carries URL userinfo in its url; ${HINT}`;
  for (const key of parsed.searchParams.keys()) {
    if (QUERY_KEY_RE.test(key)) return `${name} carries credential query key ${key} in its url; ${HINT}`;
  }
  return null;
}

function credentialReason(name, entry) {
  for (const field of ['env', 'headers']) {
    const obj = entry[field];
    if (!isPlain(obj)) continue;
    for (const key of Object.keys(obj)) {
      if (secretKey(key)) {
        return `${name} carries credential key ${key} in its ${field}; ${HINT}`;
      }
      if (typeof obj[key] === 'string' && USERINFO_RE.test(obj[key])) {
        return `${name} carries URL userinfo in ${field} value ${key}; ${HINT}`;
      }
    }
  }
  return argsReason(name, entry.args) || urlReason(name, entry.url);
}

/**
 * @param {{ cwd?: string, projectRoot?: string, home?: string }} [opts]
 * @returns {{ known: Record<string, object>, credentialed: Record<string, string> }}
 */
function resolveHeadlessMcpServers({ cwd, projectRoot, home = os.homedir() } = {}) {
  /** @type {Record<string, any>} */
  const merged = {};
  try {
    const absCwd = typeof cwd === 'string' && path.isAbsolute(cwd);
    const userCfg = readJson(path.join(home, '.claude.json'));
    Object.assign(merged, serversOf(userCfg && userCfg.mcpServers));
    if (absCwd) {
      const proj = readJson(path.join(cwd, '.mcp.json'));
      Object.assign(merged, serversOf(proj && proj.mcpServers));
      const projects = userCfg && userCfg.projects;
      const scopes = [];
      if (typeof projectRoot === 'string' && path.isAbsolute(projectRoot) && projectRoot !== cwd) scopes.push(projectRoot);
      scopes.push(cwd);
      for (const key of scopes) {
        if (isPlain(projects) && has(projects, key) && isPlain(projects[key])) {
          Object.assign(merged, serversOf(projects[key].mcpServers));
        }
      }
    }
  } catch {
    /* contribute nothing */
  }

  /** @type {Record<string, object>} */
  const known = {};
  /** @type {Record<string, string>} */
  const credentialed = {};
  for (const name of Object.keys(merged)) {
    const reason = credentialReason(name, merged[name]);
    if (reason) credentialed[name] = reason;
    else known[name] = merged[name];
  }
  known[seed.SERVER_NAME] = seed.schedulerServerEntry();
  delete credentialed[seed.SERVER_NAME];
  return { known, credentialed };
}

module.exports = { resolveHeadlessMcpServers };
