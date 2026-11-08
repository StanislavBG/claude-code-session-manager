'use strict';

/**
 * mcpToolsProbe.cjs — checks ONE MCP server by speaking MCP to it:
 * initialize → notifications/initialized → tools/list (following nextCursor,
 * at most MAX_TOOL_PAGES pages), over stdio or Streamable HTTP. It answers
 * "connected, and with which tools" for the Extensions MCP detail ("TOOLS n
 * from the last check"); mcpStatus.cjs (`claude mcp list`) gives status only.
 * On demand only: nothing here runs by itself.
 *
 * checkConfiguredMcpServer backs IPC mcp:check-server. Its request only NAMES a
 * configured server (user ~/.claude.json, project <cwd>/.mcp.json, or an
 * installed plugin's own files); the config is read from disk here, so a caller
 * can never choose the command a check spawns.
 *
 * Top-level lib/ module because no domain folder fits: it is an MCP client,
 * lib/ has no mcp/ folder (its MCP siblings mcpStdioServer.cjs and
 * mcpToolCatalog.cjs sit top-level too), and a one-file subfolder is not allowed.
 *
 * Guarantees:
 *  - checkMcpServer resolves, never rejects;
 *  - one deadline (timeoutMs) bounds the whole exchange;
 *  - at most OUTPUT_CAP_BYTES of server output is read: stdio stdout, or all
 *    HTTP response bodies of the check together;
 *  - a stdio server runs as its own process group, and the whole group is
 *    signalled (SIGTERM, then SIGKILL) on every exit path — done, timeout,
 *    error; the server itself has exited by the time the promise resolves;
 *  - server.env / server.headers values are redacted from every error, and
 *    nothing is logged.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const claudeConfig = require('./claudeConfig.cjs');
const { readJsonOr } = require('./util/atomicFs.cjs');
const { cleanChildEnv, pathWithUserBins } = require('./process/cleanEnv.cjs');
const { killTree, detachedSpawnOpts } = require('./process/killTree.cjs');
const { resolveSpawn } = require('./process/winSpawn.cjs');

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_NAME = 'session-manager';
const DEFAULT_TIMEOUT_MS = 15_000;
const OUTPUT_CAP_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_PAGES = 10;
/** `type` values checked over HTTP. 'sse' (the legacy HTTP+SSE transport) gets the
 *  Streamable-HTTP POST the MCP spec has clients try first; there is no fallback. */
const HTTP_TYPES = new Set(['http', 'streamable-http', 'sse']);

const KILL_GRACE_MS = 500; // SIGTERM → SIGKILL
const REAP_WAIT_MS = 2_000; // after SIGKILL, how long to wait for 'exit'
const EXIT_DRAIN_MS = 100; // after 'exit', time for the last stdout bytes to arrive
const SESSION_DELETE_MS = 1_000; // best-effort HTTP session teardown
const STDERR_KEEP_CHARS = 16 * 1024;
const JUNK_KEEP_CHARS = 4 * 1024;
const ERROR_BODY_CHARS = 8 * 1024;
const DETAIL_MAX_CHARS = 300;
const MIN_SECRET_CHARS = 4;

/** A check outcome other than "connected". */
class ProbeFailure extends Error {
  /**
   * @param {'failed' | 'needs-auth'} status
   * @param {string} message  fixed text, never built from config values or server output
   * @param {unknown} [detail]  config-, server- or system-derived text; redacted before it is shown
   */
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail == null || detail === '' ? null : String(detail);
  }
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A config map's primitive values as strings (env and header values must be strings). */
function stringMap(obj) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!isObject(obj)) return out;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

/**
 * The redactor for one server's error details: every server.env and
 * server.headers value (plus the token of a "<scheme> <token>" header, and any
 * URL password or query value) becomes ***. Longest first, so a secret that
 * contains another is replaced whole.
 * @returns {(text: string) => string}
 */
function makeRedactor(server) {
  /** @type {Set<string>} */
  const secrets = new Set();
  const add = (/** @type {string} */ value) => { if (value.length >= MIN_SECRET_CHARS) secrets.add(value); };
  if (isObject(server)) {
    for (const value of Object.values(stringMap(server.env))) add(value);
    for (const value of Object.values(stringMap(server.headers))) {
      add(value);
      for (const part of value.split(/\s+/)) if (part.length >= 8) add(part);
    }
    if (typeof server.url === 'string') {
      try {
        const url = new URL(server.url);
        add(url.password);
        for (const value of url.searchParams.values()) add(value);
      } catch { /* not a URL: openHttp reports that */ }
    }
  }
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  return (text) => ordered.reduce((out, secret) => out.split(secret).join('***'), text);
}

/** The resolved shape of a failed check. Redact first, then trim: a cut can't expose half a secret. */
function failureResult(err, redact) {
  const failure = err instanceof ProbeFailure
    ? err
    : new ProbeFailure('failed', 'check failed', err instanceof Error ? err.message : err);
  let detail = failure.detail === null ? '' : redact(failure.detail).replace(/\s+/g, ' ').trim();
  if (detail.length > DETAIL_MAX_CHARS) detail = `${detail.slice(0, DETAIL_MAX_CHARS - 1)}…`;
  return { ok: false, status: failure.status, error: detail ? `${failure.message}: ${detail}` : failure.message };
}

/** 300 → "0.3", 15000 → "15". */
const formatSeconds = (ms) => String(Number((ms / 1000).toFixed(2)));

// ── JSON-RPC ────────────────────────────────────────────────────────────────

const sameId = (a, b) => a === b || (typeof a === 'string' && a === String(b));

/** Is `msg` the response to request `id`? An id:null error is the server
 *  rejecting the request outright (JSON-RPC's parse / invalid-request reply). */
function isResponseTo(msg, id) {
  return isObject(msg) && typeof msg.method !== 'string'
    && (sameId(msg.id, id) || (msg.id === null && isObject(msg.error)));
}

/** The response to `id` in a parsed reply (a single message or a batch), or null. */
function findResponse(parsed, id) {
  for (const msg of Array.isArray(parsed) ? parsed : [parsed]) if (isResponseTo(msg, id)) return msg;
  return null;
}

/** A response's result; its error becomes a ProbeFailure. */
function resultOf(msg, method) {
  if (isObject(msg.error)) {
    const { message, code } = msg.error;
    throw new ProbeFailure('failed', `${method} failed`, typeof message === 'string' && message ? message : `error ${code}`);
  }
  if (!('result' in msg)) throw new ProbeFailure('failed', `invalid ${method} response`);
  return msg.result;
}

/**
 * @typedef {object} Transport
 * @property {(method: string, params: object) => Promise<any>} request  the JSON-RPC result; rejects with a ProbeFailure
 * @property {(method: string) => Promise<void>} notify
 * @property {(protocolVersion: string) => void} negotiated
 * @property {(reason: ProbeFailure) => void} abort  fail whatever is in flight, now and after
 * @property {() => Promise<void>} close  never rejects
 */

/** The MCP exchange itself, transport-agnostic. @param {Transport} transport */
async function runProtocol(transport, clientVersion) {
  const init = await transport.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: clientVersion },
  });
  if (!isObject(init)) throw new ProbeFailure('failed', 'invalid initialize result');
  transport.negotiated(typeof init.protocolVersion === 'string' && init.protocolVersion ? init.protocolVersion : PROTOCOL_VERSION);
  await transport.notify('notifications/initialized');
  // MCP: only a server that declares the tools capability serves tools/list.
  if (!isObject(init.capabilities) || !init.capabilities.tools) return [];
  return listTools(transport);
}

/** tools/list, following nextCursor for at most MAX_TOOL_PAGES pages. @param {Transport} transport */
async function listTools(transport) {
  /** @type {{ name: string, description: string }[]} */
  const tools = [];
  const names = new Set();
  const cursors = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = await transport.request('tools/list', cursor === null ? {} : { cursor });
    if (!isObject(result) || !Array.isArray(result.tools)) throw new ProbeFailure('failed', 'tools/list returned no tools array');
    for (const tool of result.tools) {
      if (!isObject(tool) || typeof tool.name !== 'string' || !tool.name || names.has(tool.name)) continue;
      names.add(tool.name);
      tools.push({ name: tool.name, description: typeof tool.description === 'string' ? tool.description : '' });
    }
    const next = result.nextCursor;
    if (typeof next !== 'string' || !next || cursors.has(next)) break; // last page, or a server repeating itself
    cursors.add(next);
    cursor = next;
  }
  return tools;
}

// ── stdio ───────────────────────────────────────────────────────────────────

function isDirectory(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function spawnFailure(err, command) {
  const code = isObject(err) && typeof err.code === 'string' ? err.code : '';
  if (code === 'ENOENT') return new ProbeFailure('failed', 'command not found', command);
  if (code === 'EACCES') return new ProbeFailure('failed', 'permission denied', command);
  // The code only: spawn's messages can quote argument and env values verbatim.
  return new ProbeFailure('failed', 'could not start server', code);
}

const ERRORISH = /(error|exception)\b|\b(cannot|can't|could not|not found|no such|denied|refused|failed|invalid|missing|unauthori[sz]ed|forbidden)\b/i;

/** The most telling stderr line: the last error-looking one, else the last line. */
function pickStderrLine(tail, trimmed) {
  const lines = tail.split(/\r?\n/)
    .slice(trimmed ? 1 : 0) // a trimmed tail starts mid-line
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s/.test(l) && !/^node\.js v\d/i.test(l));
  for (let i = lines.length - 1; i >= 0; i--) if (ERRORISH.test(lines[i])) return lines[i];
  return lines.length ? lines[lines.length - 1] : '';
}

const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;

/** Resolves true once `child` has exited, false after `ms`. */
function waitForExit(child, ms) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(false); }, ms);
    child.once('exit', onExit);
  });
}

/** Ends the server and everything in its process group: SIGTERM, then SIGKILL
 *  after KILL_GRACE_MS. Resolves once the server has exited (bounded). */
async function stopProcessGroup(child) {
  const pid = child.pid;
  if (!pid) return; // never started
  if (!hasExited(child)) {
    killTree(pid, 'SIGTERM');
    if (!(await waitForExit(child, KILL_GRACE_MS))) {
      killTree(pid, 'SIGKILL');
      await waitForExit(child, REAP_WAIT_MS);
      return;
    }
  }
  // The leader is gone, but what it spawned can outlive it (or ignore SIGTERM).
  // Signal the group only, never the bare pid, which may already be reused.
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* group already empty */ }
  }
}

/** @returns {Transport} */
function openStdio(server, cwd) {
  const command = server.command;
  if (typeof command !== 'string' || !command) throw new ProbeFailure('failed', 'server has no command');
  const dir = typeof cwd === 'string' && cwd ? cwd : os.homedir();
  if (!isDirectory(dir)) throw new ProbeFailure('failed', 'working directory not found', dir);
  const args = Array.isArray(server.args) ? server.args.map(String) : [];
  // The cleaned app env (secrets stripped) with the server's own env on top:
  // the keys it declares are its configuration, not app secrets to strip.
  const env = { ...cleanChildEnv({ PATH: pathWithUserBins() }), ...stringMap(server.env) };
  const target = resolveSpawn(command, args, { env });

  let child;
  try {
    child = spawn(target.command, target.args, {
      cwd: dir,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...detachedSpawnOpts(), // own process group, so killTree() reaches whatever the server spawns
      ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (err) {
    throw spawnFailure(err, command);
  }

  /** @type {ProbeFailure | null} set once the server can no longer answer */
  let dead = null;
  /** @type {{ id: number, method: string, resolve: (v: any) => void, reject: (e: unknown) => void } | null} */
  let pending = null;
  let lastMethod = 'initialize';
  let nextId = 1;
  let outBytes = 0;
  let outBuf = '';
  /** @type {string | null} first stdout line that was not JSON-RPC */
  let junk = null;
  let errTail = '';
  let errTrimmed = false;
  /** @type {NodeJS.Timeout | undefined} */
  let drainTimer;
  const outDecoder = new StringDecoder('utf8');
  const errDecoder = new StringDecoder('utf8');

  const fail = (/** @type {ProbeFailure} */ reason) => {
    if (dead) return;
    dead = reason;
    if (pending) {
      const p = pending;
      pending = null;
      p.reject(reason);
    }
  };
  const write = (msg) => {
    try { child.stdin.write(`${JSON.stringify(msg)}\n`); } catch { /* 'exit' / 'error' report a dead server */ }
  };
  const exitFailure = () => {
    const how = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
    const stdoutJunk = junk ?? (outBuf.trim() ? outBuf.trim().slice(0, JUNK_KEEP_CHARS) : null);
    const detail = pickStderrLine(errTail, errTrimmed) || (stdoutJunk === null ? null : `stdout was not JSON-RPC: ${stdoutJunk}`);
    return new ProbeFailure('failed', `server exited (${how}) before answering ${lastMethod}`, detail);
  };

  const onMessage = (msg) => {
    if (typeof msg.method === 'string') {
      // A request from the server must be answered (ping is the one a bare
      // client knows); its notifications need nothing.
      if (msg.id !== undefined && msg.id !== null) {
        write(msg.method === 'ping'
          ? { jsonrpc: '2.0', id: msg.id, result: {} }
          : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
      }
      return;
    }
    if (!pending || !isResponseTo(msg, pending.id)) return;
    const p = pending;
    pending = null;
    try { p.resolve(resultOf(msg, p.method)); } catch (err) { p.reject(err); }
  };

  // Lines that are not JSON-RPC are tolerated, as Claude Code's own client does
  // (some servers print a banner); they only explain a later failure.
  const onLine = (line) => {
    let parsed;
    try { parsed = JSON.parse(line); } catch { parsed = undefined; }
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      if (isObject(msg)) onMessage(msg);
      else if (junk === null) junk = line.slice(0, JUNK_KEEP_CHARS);
    }
  };

  child.stdout.on('data', (chunk) => {
    if (dead) return;
    outBytes += chunk.length;
    if (outBytes > OUTPUT_CAP_BYTES) {
      fail(new ProbeFailure('failed', 'output too large'));
      return;
    }
    const text = outDecoder.write(chunk);
    if (!text.includes('\n')) {
      outBuf += text;
      return;
    }
    const lines = (outBuf + text).split('\n');
    outBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (dead) return;
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    }
  });
  child.stderr.on('data', (chunk) => {
    errTail += errDecoder.write(chunk);
    if (errTail.length > STDERR_KEEP_CHARS) {
      errTail = errTail.slice(-STDERR_KEEP_CHARS);
      errTrimmed = true;
    }
  });
  child.stdin.on('error', () => { /* EPIPE once the server is gone: 'exit' / 'close' report it */ });
  child.on('error', (err) => fail(spawnFailure(err, command)));
  child.on('exit', () => {
    // 'close' (every pipe drained) normally follows at once, but a descendant
    // still holding stdout open can delay it indefinitely.
    if (!dead) drainTimer = setTimeout(() => fail(exitFailure()), EXIT_DRAIN_MS);
  });
  child.on('close', () => {
    clearTimeout(drainTimer);
    fail(exitFailure());
  });

  return {
    request(method, params) {
      if (dead) return Promise.reject(dead);
      lastMethod = method;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending = { id, method, resolve, reject };
        write({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method) {
      if (dead) return Promise.reject(dead);
      write({ jsonrpc: '2.0', method });
      return Promise.resolve();
    },
    negotiated() { /* stdio carries no protocol-version header */ },
    abort(reason) { fail(reason); },
    async close() {
      clearTimeout(drainTimer);
      fail(new ProbeFailure('failed', 'closed'));
      try { child.stdin.end(); } catch { /* already closed */ } // EOF: MCP's polite stdio shutdown
      await stopProcessGroup(child);
    },
  };
}

// ── Streamable HTTP ─────────────────────────────────────────────────────────

/** Splits streamed text into lines. CRLF, LF and a lone CR all end a line (SSE),
 *  including a CRLF split across two chunks. */
function lineSplitter(onLine) {
  let buf = '';
  let afterCR = false;
  return {
    push(/** @type {string} */ text) {
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (afterCR) {
          afterCR = false;
          if (c === 10) { start = i + 1; continue; }
        }
        if (c === 10 || c === 13) {
          onLine(buf + text.slice(start, i));
          buf = '';
          start = i + 1;
          afterCR = c === 13;
        }
      }
      buf += text.slice(start);
    },
    end() {
      if (buf) onLine(buf);
      buf = '';
    },
  };
}

/** Frees a response body we won't read. @param {Response} res */
async function discard(res) {
  try { await res.body?.cancel(); } catch { /* nothing left to free */ }
}

/** The useful part of a fetch failure: undici puts the socket / DNS / TLS error in `cause`. */
function networkDetail(err) {
  const cause = isObject(err) ? err.cause : null;
  if (isObject(cause)) return cause.message || cause.code || null;
  return err instanceof Error ? err.message : err;
}

/** @returns {Transport} */
function openHttp(server) {
  if (typeof server.url !== 'string' || !server.url) throw new ProbeFailure('failed', 'server has no url');
  /** @type {URL} */
  let url;
  try { url = new URL(server.url); } catch { throw new ProbeFailure('failed', 'invalid url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProbeFailure('failed', 'unsupported url scheme', url.protocol);
  const configured = new Headers();
  for (const [name, value] of Object.entries(stringMap(server.headers))) {
    // The name only: a Headers error message quotes the value.
    try { configured.set(name, value); } catch { throw new ProbeFailure('failed', 'invalid header', name); }
  }
  const legacySse = server.type === 'sse';
  const controller = new AbortController();
  /** @type {ProbeFailure | null} */
  let aborted = null;
  let sessionId = '';
  let protocolVersion = '';
  let nextId = 1;
  let budget = OUTPUT_CAP_BYTES;

  const spend = (/** @type {number} */ bytes) => {
    budget -= bytes;
    if (budget < 0) throw new ProbeFailure('failed', 'output too large');
  };

  const headers = (/** @type {boolean} */ withBody) => {
    const h = new Headers(configured);
    if (withBody) h.set('content-type', 'application/json');
    h.set('accept', 'application/json, text/event-stream');
    if (sessionId) h.set('mcp-session-id', sessionId);
    if (protocolVersion) h.set('mcp-protocol-version', protocolVersion);
    return h;
  };

  /** A body as text, counted against the cap; `limitChars` stops early (error bodies). */
  async function readBody(res, limitChars = Infinity) {
    if (limitChars === Infinity && Number(res.headers.get('content-length')) > budget) {
      await discard(res);
      throw new ProbeFailure('failed', 'output too large');
    }
    if (!res.body) return '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return text + decoder.decode();
        spend(value.byteLength);
        text += decoder.decode(value, { stream: true });
        if (text.length >= limitChars) return text;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  /** An error reply's most useful text: its JSON-RPC error message, else the status text. */
  async function errorDetail(res) {
    let text = '';
    try { text = await readBody(res, ERROR_BODY_CHARS); } catch { /* the status says enough */ }
    try {
      const parsed = JSON.parse(text);
      const error = (Array.isArray(parsed) ? parsed[0] : parsed)?.error;
      if (isObject(error) && typeof error.message === 'string') return error.message;
      if (typeof error === 'string') return error;
    } catch { /* not JSON */ }
    return res.statusText;
  }

  /** POSTs one JSON-RPC message; returns the response once it is 2xx. */
  async function post(message) {
    const res = await fetch(url, { method: 'POST', headers: headers(true), body: JSON.stringify(message), signal: controller.signal });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (res.status === 401 || res.status === 403) {
      await discard(res);
      throw new ProbeFailure('needs-auth', `authentication required (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const unsupported = legacySse && res.status < 500 ? ' (legacy SSE transport is not supported)' : '';
      throw new ProbeFailure('failed', `HTTP ${res.status}${unsupported}`, await errorDetail(res));
    }
    return res;
  }

  /** Reads SSE events until one carries the response to `id`, then stops,
   *  even if the server keeps the stream open. */
  async function readEvents(res, id, method) {
    if (!res.body) throw new ProbeFailure('failed', `empty ${method} event stream`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    /** @type {string[]} */
    let data = [];
    let found = null;
    const dispatch = () => {
      const payload = data.join('\n');
      data = [];
      if (found || !payload) return;
      try { found = findResponse(JSON.parse(payload), id); } catch { /* not JSON: skip the event */ }
    };
    const lines = lineSplitter((line) => {
      if (line === '') { dispatch(); return; }
      if (line.startsWith(':')) return; // comment / keep-alive
      const colon = line.indexOf(':');
      if ((colon === -1 ? line : line.slice(0, colon)) !== 'data') return; // event:, id:, retry:
      const value = colon === -1 ? '' : line.slice(colon + 1);
      data.push(value.startsWith(' ') ? value.slice(1) : value);
    });
    try {
      while (!found) {
        const { done, value } = await reader.read();
        if (done) {
          lines.end();
          dispatch();
          break;
        }
        spend(value.byteLength);
        lines.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    if (!found) throw new ProbeFailure('failed', `the ${method} event stream ended without a response`);
    return found;
  }

  /** The response to request `id`, from a JSON or an SSE reply. */
  async function readReply(res, id, method) {
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type.includes('text/event-stream')) return readEvents(res, id, method);
    if (type.includes('json')) {
      const text = await readBody(res);
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new ProbeFailure('failed', `invalid JSON in the ${method} reply`); }
      const reply = findResponse(parsed, id);
      if (!reply) throw new ProbeFailure('failed', `no ${method} response in the reply`);
      return reply;
    }
    await discard(res);
    throw new ProbeFailure('failed', `unexpected ${method} reply type`, type || 'none');
  }

  /** After the deadline every failure is the timeout; otherwise network errors get a reason. */
  const asFailure = (err, method) => aborted
    || (err instanceof ProbeFailure ? err : new ProbeFailure('failed', `${method} request failed`, networkDetail(err)));

  return {
    async request(method, params) {
      if (aborted) throw aborted;
      const id = nextId++;
      try {
        const res = await post({ jsonrpc: '2.0', id, method, params });
        return resultOf(await readReply(res, id, method), method);
      } catch (err) {
        throw asFailure(err, method);
      }
    },
    async notify(method) {
      if (aborted) throw aborted;
      try {
        await discard(await post({ jsonrpc: '2.0', method }));
      } catch (err) {
        throw asFailure(err, method);
      }
    },
    negotiated(version) { protocolVersion = version; },
    abort(reason) {
      if (aborted) return;
      aborted = reason;
      controller.abort();
    },
    async close() {
      // MCP: a client done with a session SHOULD end it with DELETE. Best
      // effort, and skipped after a timeout: that server isn't answering.
      if (!sessionId || aborted) return;
      try {
        await discard(await fetch(url, { method: 'DELETE', headers: headers(false), signal: AbortSignal.timeout(SESSION_DELETE_MS) }));
      } catch { /* the server expires the session itself */ }
    },
  };
}

// ── entry point ─────────────────────────────────────────────────────────────

/** Picks the transport. An explicit `type` wins; otherwise a url means HTTP and a command means stdio. */
function openTransport(server, cwd) {
  if (!isObject(server)) throw new ProbeFailure('failed', 'invalid server config');
  const type = typeof server.type === 'string' ? server.type : '';
  if (type === 'stdio') return openStdio(server, cwd);
  if (HTTP_TYPES.has(type)) return openHttp(server);
  if (type) throw new ProbeFailure('failed', 'unsupported transport', type);
  if (server.url) return openHttp(server);
  if (server.command) return openStdio(server, cwd);
  throw new ProbeFailure('failed', 'server has no command or url');
}

/**
 * Checks ONE MCP server: initialize → notifications/initialized → tools/list.
 *
 * @param {unknown} server  one mcpServers entry: { type?, command?, args?, env?, url?, headers? }
 * @param {{ timeoutMs?: number, clientVersion?: string, cwd?: string }} [options]
 *   timeoutMs bounds the whole exchange (stopping a stdio server afterwards can
 *   add up to ~2.5 s); clientVersion goes out as clientInfo.version; cwd is where
 *   a stdio server starts (default: the home directory; pass the project root
 *   for a project-scoped server whose command or args are relative).
 * @returns {Promise<
 *   | { ok: true, status: 'connected', tools: { name: string, description: string }[], checkedAt: number }
 *   | { ok: false, status: 'failed' | 'needs-auth', error: string, checkedAt: number }>}
 *   Never rejects. A server listing more than MAX_TOOL_PAGES pages reports the tools of the first ones.
 */
async function checkMcpServer(server, options) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, clientVersion, cwd } = options || {};
  const limit = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const version = typeof clientVersion === 'string' && clientVersion ? clientVersion : 'unknown';
  /** @type {(text: string) => string} */
  let redact = (text) => text;
  /** @type {Transport | null} */
  let transport = null;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  let outcome;
  try {
    redact = makeRedactor(server);
    const open = openTransport(server, cwd);
    transport = open;
    const deadline = new ProbeFailure('failed', `timed out after ${formatSeconds(limit)}s`);
    timer = setTimeout(() => open.abort(deadline), limit);
    outcome = { ok: true, status: 'connected', tools: await runProtocol(open, version) };
  } catch (err) {
    outcome = failureResult(err, redact);
  } finally {
    clearTimeout(timer);
    if (transport) await transport.close().catch(() => {});
  }
  return { ...outcome, checkedAt: Date.now() };
}

// ── configured servers (IPC mcp:check-server) ───────────────────────────────

/**
 * @typedef {{ source: 'user' | 'project' | 'plugin', name: string, cwd?: string, pluginKey?: string }} McpServerRequest
 *   WHICH configured server: user = ~/.claude.json mcpServers, project =
 *   <cwd>/.mcp.json mcpServers, plugin = a server of the installed plugin keyed
 *   pluginKey (name@marketplace). cwd counts for a project server only.
 */

const PLUGIN_ROOT_VAR = '${CLAUDE_PLUGIN_ROOT}';

/** @param {object} obj @param {string} key */
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** map[name] when it is the map's own object entry — never an inherited key such as __proto__. */
function ownEntry(map, name) {
  return isObject(map) && hasOwn(map, name) && isObject(map[name]) ? map[name] : null;
}

/** The manifest: .claude-plugin/plugin.json, else the legacy root plugin.json; null when the first one present doesn't parse. */
async function readPluginManifest(root) {
  for (const file of [path.join(root, '.claude-plugin', 'plugin.json'), path.join(root, 'plugin.json')]) {
    if (!(await fsp.access(file).then(() => true, () => false))) continue;
    const data = await readJsonOr(file, null);
    return isObject(data) ? data : null;
  }
  return null;
}

/** A server map from `{ mcpServers: {...} }`, or a bare map whose every value has a command or url. */
function pluginServerMap(data) {
  if (!isObject(data)) return null;
  if (isObject(data.mcpServers)) return data.mcpServers;
  const values = Object.values(data);
  const bare = values.length > 0 && values.every((d) => isObject(d) && (typeof d.command === 'string' || typeof d.url === 'string'));
  return bare ? data : null;
}

/**
 * A plugin's server maps in the order the Plugins tab reads them (renderer
 * lib/pluginContents.ts listPluginMcpServers), so a server it lists is a server
 * this finds: the manifest's inline mcpServers object, then each file the
 * manifest declares inside the plugin root, then the default .mcp.json.
 * Unreadable or malformed files are skipped.
 * @param {string} root  the resolved, absolute install dir
 */
async function pluginServerMaps(root) {
  const manifest = await readPluginManifest(root);
  const decl = manifest ? manifest.mcpServers : undefined;
  const declared = typeof decl === 'string' ? [decl] : Array.isArray(decl) ? decl.filter((d) => typeof d === 'string') : [];
  /** @type {Set<string>} */
  const files = new Set();
  for (const rel of declared) {
    const abs = path.resolve(root, rel);
    if (abs === root || abs.startsWith(root + path.sep)) files.add(abs);
  }
  files.add(path.join(root, '.mcp.json'));
  const bodies = await Promise.all([...files].map((file) => readJsonOr(file, null)));
  return [isObject(decl) ? decl : null, ...bodies].map(pluginServerMap).filter(isObject);
}

/** A copy of a JSON value with ${CLAUDE_PLUGIN_ROOT} in every string replaced by root, as Claude Code expands a plugin's servers. */
function expandPluginRoot(value, root) {
  if (typeof value === 'string') return value.split(PLUGIN_ROOT_VAR).join(root);
  if (Array.isArray(value)) return value.map((v) => expandPluginRoot(v, root));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandPluginRoot(v, root)]));
  return value;
}

/**
 * The config of ONE configured MCP server, read from disk.
 *
 * @param {McpServerRequest} request
 * @param {{ home?: string }} [options]  home is injectable for tests
 * @returns {Promise<{ server: Record<string, any>, cwd: string } | null>}
 *   null when no such server is configured. cwd is where a stdio server starts:
 *   the project root for a project server, else the home directory (Claude Code
 *   starts a server in its session's directory, and a check has none). Rejects
 *   when ~/.claude.json or <cwd>/.mcp.json exists but is not a JSON object.
 */
async function resolveMcpServerConfig(request, options) {
  const home = (options && options.home) || os.homedir();
  const { source, name, cwd, pluginKey } = isObject(request) ? request : {};
  if (typeof name !== 'string' || !name) return null;
  if (source === 'user') {
    const { data } = await claudeConfig.read({ fileId: 'claudeJson', scope: 'user', home });
    const server = ownEntry(data.mcpServers, name);
    return server ? { server, cwd: home } : null;
  }
  if (source === 'project') {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
    const { data } = await claudeConfig.read({ fileId: 'mcpJson', scope: 'project', cwd });
    const server = ownEntry(data.mcpServers, name);
    return server ? { server, cwd } : null;
  }
  if (source === 'plugin') {
    // Required here, not at the top: pluginInstall.cjs pulls in electron, node-pty
    // and ipcSchemas.cjs, none of which a plain checkMcpServer caller needs.
    const { listInstalled } = require('../pluginInstall.cjs');
    const plugin = typeof pluginKey === 'string' ? listInstalled(home).find((p) => p.key === pluginKey) : undefined;
    if (!plugin || typeof plugin.installPath !== 'string' || !path.isAbsolute(plugin.installPath)) return null;
    const root = path.resolve(plugin.installPath);
    for (const map of await pluginServerMaps(root)) {
      // The first definition of a name wins, as in the Plugins tab's list.
      if (hasOwn(map, name)) return isObject(map[name]) ? { server: expandPluginRoot(map[name], root), cwd: home } : null;
    }
  }
  return null;
}

/**
 * IPC mcp:check-server's body: resolves the request to ONE configured server
 * and checks it.
 *
 * @param {McpServerRequest} request
 * @param {{ home?: string, timeoutMs?: number, clientVersion?: string, check?: typeof checkMcpServer }} [options]
 *   home and check are injectable for tests; timeoutMs and clientVersion go to checkMcpServer.
 * @returns {ReturnType<typeof checkMcpServer>}  checkMcpServer's result, unchanged. A server
 *   that isn't configured resolves to { ok: false, status: 'failed', error: 'server not found' }
 *   with nothing spawned; a config file that can't be parsed rejects, also with nothing spawned.
 */
async function checkConfiguredMcpServer(request, options) {
  const { home, check = checkMcpServer, timeoutMs, clientVersion } = options || {};
  const target = await resolveMcpServerConfig(request, { home });
  if (!target) return { ok: false, status: 'failed', error: 'server not found', checkedAt: Date.now() };
  return check(target.server, { timeoutMs, clientVersion, cwd: target.cwd });
}

module.exports = { checkMcpServer, resolveMcpServerConfig, checkConfiguredMcpServer };
