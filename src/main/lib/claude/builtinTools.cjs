'use strict';

/**
 * builtinTools.cjs — learns the claude CLI's real built-in tool and bundled-skill
 * names from the stream-json `system`/`init` event of a minimal run. The init
 * event is emitted before the first API call, so the child is killed on init and
 * no model tokens are spent. Cached in memory per CLI version; any failure
 * returns FALLBACK_TOOLS (source 'fallback') and never throws.
 */

const os = require('node:os');
const { resolveClaudeBin, probeClaudeVersion } = require('./claudeBin.cjs');
const { killTree, detachedSpawnOpts } = require('../process/killTree.cjs');
const { cleanChildEnv } = require('../process/cleanEnv.cjs');

const FALLBACK_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill', 'NotebookEdit', 'TodoWrite'];
const PROBE_TIMEOUT_MS = 20_000;
const OUTPUT_CAP_BYTES = 2 * 1024 * 1024;

/** @type {Map<string, { tools: string[], skills: string[], source: 'cli' | 'fallback', cliVersion: string | null }>} */
const cache = new Map();

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);

/** Probe argv: pinned model, no user MCP, no user/project/local settings or plugins. */
function probeArgs() {
  return ['--model', 'haiku', '-p', 'hi', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--setting-sources', 'project'];
}

/**
 * Spawn the probe; resolve with the parsed init event or null. Never rejects.
 * @returns {Promise<Record<string, any> | null>}
 */
function runProbe(spawn, claudeBin) {
  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let buf = '';
    let bytes = 0;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (child && child.pid) { try { killTree(child.pid, 'SIGKILL'); } catch { /* */ } }
      else if (child && typeof child.kill === 'function') { try { child.kill('SIGKILL'); } catch { /* */ } }
      resolve(value);
    };
    const feed = (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { return finish(null); }
        if (evt && evt.type === 'system' && evt.subtype === 'init') return finish(evt);
      }
      if (bytes > OUTPUT_CAP_BYTES) finish(null);
    };
    try {
      child = spawn(claudeBin, probeArgs(), {
        cwd: os.tmpdir(),
        env: cleanChildEnv(),
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        ...detachedSpawnOpts(),
      });
      timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
      if (child.stdout) child.stdout.on('data', feed);
      child.on('error', () => finish(null));
      child.on('close', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

/**
 * @param {{ spawn?: Function, claudeBin?: string, cliVersion?: string | null }} [opts]
 * @returns {Promise<{ tools: string[], skills: string[], source: 'cli' | 'fallback', cliVersion: string | null }>}
 */
async function getBuiltinTools({ spawn, claudeBin, cliVersion } = {}) {
  let version = cliVersion || null;
  try {
    if (!version) version = await probeClaudeVersion();
  } catch { /* version stays null */ }
  const key = version || '';
  const hit = version ? cache.get(key) : undefined;
  if (hit) return { ...hit, tools: [...hit.tools], skills: [...hit.skills] };
  try {
    const doSpawn = spawn || require('node:child_process').spawn;
    const init = await runProbe(doSpawn, claudeBin || resolveClaudeBin());
    const tools = init ? strings(init.tools).filter((t) => !t.startsWith('mcp__')) : [];
    if (init && tools.length) {
      const result = { tools, skills: strings(init.skills), source: /** @type {const} */ ('cli'), cliVersion: version };
      if (version) cache.set(key, result);
      return { ...result, tools: [...tools], skills: [...result.skills] };
    }
  } catch { /* fall through */ }
  return { tools: [...FALLBACK_TOOLS], skills: [], source: 'fallback', cliVersion: version };
}

/** Test hook — forget cached probes. */
function __resetForTests() { cache.clear(); }

module.exports = { getBuiltinTools, FALLBACK_TOOLS, __resetForTests };
