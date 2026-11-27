'use strict';

/**
 * serviceStdioBridge.cjs — the no-code way in for an outside service (first
 * one: Kiln). Routed from bin/cli.cjs before any Electron code loads; must
 * never require electron.
 *
 *   npx claude-code-session-manager service pair --code X --name Kiln --state-dir D [--device P] [--timeout S]
 *   npx claude-code-session-manager service mcp --state-dir D
 *
 * - pair: redeems the one-time code (serviceClient.pair, device prefix passed
 *   through), connects, prints the SAS + where to confirm it, and exits 0 once
 *   the desktop confirms (connect() resolves). Bad/expired code, ambiguous
 *   device, revocation or timeout (default 300 s) exit 1 with a message.
 * - mcp: a stdio MCP server, newline-delimited JSON-RPC 2.0. tools/list and
 *   tools/call are forwarded to the paired desktop's remote session;
 *   initialize/ping are answered here once that session is ready (serviceClient
 *   exposes no generic rpc). Stdout carries protocol messages only; logs go to
 *   stderr. stdin close exits 0; a revoked client exits 3 ('revoked: pair again').
 *
 * runServiceCli(argv, { stdin, stdout, stderr, clientFactory }) resolves to the
 * exit code; argv excludes the leading 'service'.
 */

const { SUPPORTED_PROTOCOL_VERSIONS } = require('../mcpStdioServer.cjs');

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_REVOKED = 3;
const DEFAULT_PAIR_TIMEOUT_S = 300;
const REVOKE_POLL_MS = 1_000;
const CONFIRM_HINT = 'Confirm this code in Session Manager -> App Settings -> Web remote -> Services';
const REVOKED_MSG = 'revoked: pair again';

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

const USAGE = [
  'usage:',
  '  claude-code-session-manager service pair --code <code> --name <name> --state-dir <dir> [--device <prefix>] [--timeout <seconds>]',
  '  claude-code-session-manager service mcp --state-dir <dir>',
  '  claude-code-session-manager service pair-local --state-dir <dir> --name <name> --home <cwd> --tools a,b,c [--project-root <dir>] [--device <prefix>] [--timeout <seconds>]',
].join('\n');

/** Parses `--key value` / `--key=value` pairs. Returns { flags } or { error }. */
function parseFlags(args, allowed) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (typeof a !== 'string' || !a.startsWith('--')) return { error: `unexpected argument: ${a}` };
    const eq = a.indexOf('=');
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (!allowed.includes(key)) return { error: `unknown option: --${key}` };
    let value;
    if (eq !== -1) value = a.slice(eq + 1);
    else {
      value = args[i + 1];
      if (value === undefined || (typeof value === 'string' && value.startsWith('--'))) return { error: `--${key} needs a value` };
      i += 1;
    }
    flags[key] = value;
  }
  return { flags };
}

function defaultClientFactory(opts) {
  const { createServiceClient } = require('./serviceClient.cjs');
  return createServiceClient(opts);
}

function line(stream, text) {
  try { stream.write(`${text}\n`); } catch { /* closed stream */ }
}

function isRevoked(client, err) {
  return (err && err.code === 'revoked') || (client && client.state === 'revoked');
}

async function runPair(args, { stdout, stderr, clientFactory }) {
  const parsed = parseFlags(args, ['code', 'name', 'state-dir', 'device', 'timeout']);
  if (parsed.error) { line(stderr, `${parsed.error}\n${USAGE}`); return EXIT_USAGE; }
  const { flags } = parsed;
  for (const k of ['code', 'name', 'state-dir']) {
    if (!flags[k]) { line(stderr, `missing --${k}\n${USAGE}`); return EXIT_USAGE; }
  }
  let timeoutS = DEFAULT_PAIR_TIMEOUT_S;
  if (flags.timeout !== undefined) {
    timeoutS = Number(flags.timeout);
    if (!Number.isFinite(timeoutS) || timeoutS <= 0) { line(stderr, `--timeout must be a positive number of seconds\n${USAGE}`); return EXIT_USAGE; }
  }

  let sasShown = false;
  const showSas = (sas) => {
    if (sasShown || !sas) return;
    sasShown = true;
    line(stdout, `SAS: ${sas}`);
    line(stdout, CONFIRM_HINT);
  };

  let client;
  try {
    client = clientFactory({ stateDir: flags['state-dir'], onSas: showSas });
  } catch (err) {
    line(stderr, `service pair: ${err && err.message ? err.message : String(err)}`);
    return EXIT_FAIL;
  }

  let timer = null;
  try {
    const pairArgs = { code: flags.code, name: flags.name };
    if (flags.device !== undefined) pairArgs.device = flags.device;
    await client.pair(pairArgs);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`timed out after ${timeoutS} s waiting for the desktop to confirm`);
        e.code = 'timeout';
        reject(e);
      }, timeoutS * 1000);
    });
    const res = await Promise.race([client.connect(), timeout]);
    showSas(res && res.sas);
    line(stdout, 'Paired: the desktop confirmed this service.');
    return EXIT_OK;
  } catch (err) {
    if (isRevoked(client, err)) line(stderr, `service pair: ${REVOKED_MSG}`);
    else line(stderr, `service pair: ${err && err.message ? err.message : String(err)}`);
    return EXIT_FAIL;
  } finally {
    clearTimeout(timer);
    try { client.close(); } catch { /* best-effort */ }
  }
}

const NOT_RUNNING_MSG = 'session manager is not running (no admin-api.json)';

function errText(err) { return err && err.message ? err.message : String(err); }

/**
 * Pairs a same-machine service through the loopback admin API, no window step.
 * The redeem targets the start route's `deviceId` (this desktop), or `device` (a prefix) when the
 * caller overrides it; without either, 2+ paired desktops fail with "choose a device".
 * @param {{ stateDir: string, name: string, homeCwd: string, tools: string[], projectRoot?: string, device?: string, timeoutS?: number, fetchImpl?: Function, clientFactory?: Function, adminApiPath?: string }} opts
 * @returns {Promise<{ ok: true, service: any } | { ok: false, error: string }>}
 */
async function pairLocal(opts) {
  const { stateDir, name, homeCwd, tools, projectRoot, device, timeoutS = DEFAULT_PAIR_TIMEOUT_S } = opts || {};
  const fetchImpl = (opts && opts.fetchImpl) || globalThis.fetch;
  const clientFactory = (opts && opts.clientFactory) || defaultClientFactory;
  let admin;
  try {
    const adminApiPath = (opts && opts.adminApiPath) || require('../scheduler/schedulerPaths.cjs').adminTokenPath();
    admin = require('../util/atomicFs.cjs').readJsonOrSync(adminApiPath, null);
  } catch { return { ok: false, error: NOT_RUNNING_MSG }; }
  if (!admin || !admin.port || !admin.token) return { ok: false, error: NOT_RUNNING_MSG };
  const base = `http://127.0.0.1:${admin.port}/admin/services/pair-local`;

  const post = async (url, body) => {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
        body: JSON.stringify(body),
      });
    } catch (err) { return { ok: false, error: `admin api unreachable: ${errText(err)}` }; }
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok || !json || json.ok === false) return { ok: false, error: (json && json.error) || `admin api HTTP ${res.status}` };
    return json;
  };

  let client;
  let timer = null;
  try {
    const startBody = { name, homeCwd, tools };
    if (projectRoot) startBody.projectRoot = projectRoot;
    const started = await post(base, startBody);
    if (!started.ok) return { ok: false, error: started.error };

    let rejectConfirm;
    const confirmFailed = new Promise((_, rej) => { rejectConfirm = rej; });
    confirmFailed.catch(() => {});
    let confirmP = null;
    const onSas = (sas) => {
      if (confirmP || !sas) return;
      confirmP = post(`${base}/confirm`, { pairingId: started.pairingId, sas: String(sas).replace(/\D/g, '') });
      confirmP.then((r) => { if (!r.ok) rejectConfirm(new Error(r.error)); });
    };
    client = clientFactory({ stateDir, onSas });
    const pairArgs = { code: started.code, name };
    const target = device || started.deviceId;
    if (target) pairArgs.device = String(target);
    await client.pair(pairArgs);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutS} s waiting for pairing to confirm`)), timeoutS * 1000);
    });
    const res = await Promise.race([client.connect(), confirmFailed, timeout]);
    if (res && res.sas) onSas(res.sas);
    const confirmed = confirmP ? await confirmP : { ok: false, error: 'no SAS was derived' };
    if (!confirmed.ok) return { ok: false, error: confirmed.error };
    return { ok: true, service: confirmed.service };
  } catch (err) {
    return { ok: false, error: errText(err) };
  } finally {
    clearTimeout(timer);
    try { if (client) client.close(); } catch { /* best-effort */ }
  }
}

async function runPairLocal(args, { stdout, stderr, clientFactory, fetchImpl, adminApiPath }) {
  const parsed = parseFlags(args, ['state-dir', 'name', 'home', 'tools', 'project-root', 'device', 'timeout']);
  if (parsed.error) { line(stderr, `${parsed.error}\n${USAGE}`); return EXIT_USAGE; }
  const { flags } = parsed;
  for (const k of ['state-dir', 'name', 'home', 'tools']) {
    if (!flags[k]) { line(stderr, `missing --${k}\n${USAGE}`); return EXIT_USAGE; }
  }
  const tools = flags.tools.split(',').map((t) => t.trim()).filter(Boolean);
  if (!tools.length) { line(stderr, `missing --tools\n${USAGE}`); return EXIT_USAGE; }
  let timeoutS = DEFAULT_PAIR_TIMEOUT_S;
  if (flags.timeout !== undefined) {
    timeoutS = Number(flags.timeout);
    if (!Number.isFinite(timeoutS) || timeoutS <= 0) { line(stderr, `--timeout must be a positive number of seconds\n${USAGE}`); return EXIT_USAGE; }
  }
  const r = await pairLocal({
    stateDir: flags['state-dir'], name: flags.name, homeCwd: flags.home, tools,
    projectRoot: flags['project-root'], device: flags.device, timeoutS, clientFactory, fetchImpl, adminApiPath,
  });
  if (!r.ok) { line(stderr, `service pair-local: ${r.error}`); return EXIT_FAIL; }
  line(stdout, `Paired locally: ${flags.name}`);
  return EXIT_OK;
}

function runMcp(args, { stdin, stdout, stderr, clientFactory }) {
  const parsed = parseFlags(args, ['state-dir']);
  if (parsed.error) { line(stderr, `${parsed.error}\n${USAGE}`); return Promise.resolve(EXIT_USAGE); }
  const stateDir = parsed.flags['state-dir'];
  if (!stateDir) { line(stderr, `missing --state-dir\n${USAGE}`); return Promise.resolve(EXIT_USAGE); }

  let client;
  try {
    client = clientFactory({ stateDir, onSas: (sas) => line(stderr, `[service mcp] SAS ${sas}`) });
  } catch (err) {
    line(stderr, `service mcp: ${err && err.message ? err.message : String(err)}`);
    return Promise.resolve(EXIT_FAIL);
  }

  return new Promise((resolve) => {
    let done = false;
    let buffer = '';
    let ready = null;
    let poll = null;

    function finish(code) {
      if (done) return;
      done = true;
      clearInterval(poll);
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('close', onEnd);
      try { client.close(); } catch { /* best-effort */ }
      resolve(code);
    }

    function revoked() {
      line(stderr, REVOKED_MSG);
      finish(EXIT_REVOKED);
    }

    function send(msg) {
      if (done) return;
      try { stdout.write(`${JSON.stringify(msg)}\n`); } catch (err) {
        line(stderr, `[service mcp] write failed: ${err && err.message}`);
      }
    }

    function ensureReady() {
      if (!ready) {
        ready = Promise.resolve().then(() => client.connect());
        ready.then(() => line(stderr, '[service mcp] connected'), () => { ready = null; });
      }
      return ready;
    }

    async function dispatch(msg) {
      const hasId = msg && typeof msg === 'object' && msg.id !== undefined && msg.id !== null;
      if (!hasId) return; // notification: never answered
      const { id, method, params } = msg;
      try {
        let result;
        switch (method) {
          case 'initialize': {
            await ensureReady();
            const requested = params && params.protocolVersion;
            result = {
              protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
              capabilities: { tools: {} },
              serverInfo: { name: 'session-manager-service', version: '1' },
            };
            break;
          }
          case 'ping':
            result = {};
            break;
          case 'tools/list':
            await ensureReady();
            result = { tools: await client.listTools() };
            break;
          case 'tools/call': {
            await ensureReady();
            const name = params && params.name;
            const callArgs = params && params.arguments ? params.arguments : {};
            result = await client.callTool(name, callArgs);
            break;
          }
          default:
            send({ jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } });
            return;
        }
        send({ jsonrpc: '2.0', id, result });
      } catch (err) {
        if (isRevoked(client, err)) {
          send({ jsonrpc: '2.0', id, error: { code: INTERNAL_ERROR, message: REVOKED_MSG } });
          revoked();
          return;
        }
        const code = err && Number.isInteger(err.rpcCode) ? err.rpcCode : INTERNAL_ERROR;
        send({ jsonrpc: '2.0', id, error: { code, message: err && err.message ? err.message : String(err) } });
      }
    }

    function handleLine(raw) {
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!text.trim()) return;
      let msg;
      try { msg = JSON.parse(text); } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
        return;
      }
      dispatch(msg).catch((err) => line(stderr, `[service mcp] dispatch failed: ${err && err.message}`));
    }

    function onData(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let idx;
      while (!done && (idx = buffer.indexOf('\n')) !== -1) {
        const l = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(l);
      }
    }

    function onEnd() {
      finish(EXIT_OK);
    }

    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('close', onEnd);
    poll = setInterval(() => { if (client.state === 'revoked') revoked(); }, REVOKE_POLL_MS);
    if (typeof poll.unref === 'function') poll.unref();
    // Connect eagerly so the SAS/logs appear before the first request; failures surface per request.
    ensureReady().catch((err) => {
      if (isRevoked(client, err)) revoked();
      else line(stderr, `[service mcp] connect failed: ${err && err.message ? err.message : String(err)}`);
    });
  });
}

/**
 * @param {string[]} argv arguments after 'service'
 * @param {{ stdin?: any, stdout?: any, stderr?: any, clientFactory?: Function }} [io]
 * @returns {Promise<number>} exit code
 */
async function runServiceCli(argv, io = {}) {
  const deps = {
    stdin: io.stdin || process.stdin,
    stdout: io.stdout || process.stdout,
    stderr: io.stderr || process.stderr,
    clientFactory: io.clientFactory || defaultClientFactory,
    fetchImpl: io.fetchImpl,
    adminApiPath: io.adminApiPath,
  };
  const [sub, ...rest] = Array.isArray(argv) ? argv : [];
  if (sub === 'pair') return runPair(rest, deps);
  if (sub === 'pair-local') return runPairLocal(rest, deps);
  if (sub === 'mcp') return runMcp(rest, deps);
  line(deps.stderr, sub ? `unknown service subcommand: ${sub}\n${USAGE}` : USAGE);
  return EXIT_USAGE;
}

module.exports = { runServiceCli, pairLocal, USAGE, CONFIRM_HINT, REVOKED_MSG, EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_REVOKED };
