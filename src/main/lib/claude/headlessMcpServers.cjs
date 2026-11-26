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

function credentialReason(name, entry) {
  for (const field of ['env', 'headers']) {
    const obj = entry[field];
    if (!isPlain(obj)) continue;
    for (const key of Object.keys(obj)) {
      if (SECRET_KEY_RE.test(key) || /^authorization$/i.test(key)) {
        return `${name} carries credential key ${key} in its ${field}; move the secret to a vault ref (environment profile) or run it outside the job`;
      }
    }
  }
  return null;
}

/**
 * @param {{ cwd?: string, home?: string }} [opts]
 * @returns {{ known: Record<string, object>, credentialed: Record<string, string> }}
 */
function resolveHeadlessMcpServers({ cwd, home = os.homedir() } = {}) {
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
      if (isPlain(projects) && has(projects, cwd) && isPlain(projects[cwd])) {
        Object.assign(merged, serversOf(projects[cwd].mcpServers));
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
