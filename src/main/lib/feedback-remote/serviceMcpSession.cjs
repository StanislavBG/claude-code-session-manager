/**
 * serviceMcpSession.cjs — answers one paired service's MCP JSON-RPC 2.0
 * messages (initialize, ping, tools/list, tools/call) over the Web Remote relay.
 *
 *   handleServiceMcp(msg, { service, invoke, store }) -> Promise<{ response, audit }>
 *
 * - service: a servicePairings public record ({ serviceId, homeCwd, scope, ... }).
 * - invoke(method, path, { body, query }) -> Promise<{ status, json }> — the
 *   localAdminHttp in-process route call. The only way this module acts.
 * - store: { recordOpened(serviceId, { cwd, epicId, externalRef? }),
 *   hasOpened(serviceId, cwd, epicId) } — the servicePairings ledger of Epics
 *   the service opened, keyed by project + id.
 *
 * Rules:
 * - tools/list and tools/call see only SERVICE_TOOLS named in service.scope;
 *   anything else is a JSON-RPC error with audit result 'refused:scope' and
 *   invoke is never called.
 * - feedback_open_session is pinned to the service's project: fromCwd missing
 *   -> service.homeCwd, a different fromCwd is refused; replyMode defaults to
 *   'event' (a service has no chat to wake). An ok answer's epicId goes into
 *   the ledger under toCwd — and macro_run's under its cwd.
 * - epic_get answers the route's own 404 shape for any (project, Epic) not in
 *   the ledger — checked with the call's cwd, or the returned epic's cwd for
 *   an id-only call — so a service cannot probe other Epics, nor the same id
 *   in another project; events_read keeps epic_state_changed rows only for a
 *   ledger (cwd, epicId) and epic_cross_project_reply rows only for a ledger
 *   (fromCwd, fromEpicId).
 * - project_create is pinned to the pairing's owner-approved projects folder:
 *   no service.projectRoot -> refused (403, 'refused:projectRoot'); a given
 *   parentDir that does not path.resolve() to projectRoot -> refused (403,
 *   'refused:parentDir'); otherwise the route gets parentDir = projectRoot and
 *   fromCwd = service.homeCwd (a caller's fromCwd is overwritten).
 *
 * response is null for a notification (no id). audit is null for anything but
 * tools/call, else { tool, result } (result: 'ok' | 'error:<status>' |
 * 'refused:scope' | 'refused:fromCwd' | 'refused:ledger' |
 * 'refused:projectRoot' | 'refused:parentDir' | 'error:invalid-params'
 * | 'error:invoke').
 *
 * No Electron, no I/O of its own.
 */
'use strict';

const path = require('node:path');
const { SERVICE_TOOLS, EVENTS_READ_KINDS } = require('./serviceMcpTools.cjs');
const { SUPPORTED_PROTOCOL_VERSIONS } = require('../mcpStdioServer.cjs');

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
/** JSON-RPC server-defined error: the tool is not granted to this service. */
const SCOPE_REFUSED = -32001;

const NOT_FOUND = Object.freeze({ status: 404, json: Object.freeze({ ok: false, error: 'not found' }) });

let cachedVersion = null;
function appVersion() {
  if (cachedVersion === null) {
    try { cachedVersion = String(require('../../../../package.json').version || '0.0.0'); } catch { cachedVersion = '0.0.0'; }
  }
  return cachedVersion;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult({ status, json }) {
  const payload = json === null || json === undefined ? { ok: false, status } : json;
  const out = { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  if (!(status >= 200 && status < 300)) out.isError = true;
  return out;
}

function scopedTools(service) {
  const scope = Array.isArray(service?.scope) ? service.scope : [];
  return SERVICE_TOOLS.filter((t) => scope.includes(t.name));
}

function isOk(answer) {
  return answer.status >= 200 && answer.status < 300 && answer.json?.ok === true;
}

async function callInvoke(invoke, req, trustedService) {
  const opts = { body: req.body, query: req.query };
  if (trustedService) opts.trustedService = trustedService;
  const answer = await invoke(req.method, req.path, opts);
  return { status: Number(answer?.status) || 500, json: answer?.json ?? null };
}

async function recordEpic(store, service, answer, cwd, externalRef) {
  const epicId = answer.json?.epicId;
  if (!isOk(answer) || typeof epicId !== 'string' || epicId === '') return null;
  const ref = typeof answer.json?.externalRef === 'string' && answer.json.externalRef !== '' ? answer.json.externalRef : externalRef;
  try {
    await store.recordOpened(service.serviceId, { cwd, epicId, externalRef: typeof ref === 'string' && ref !== '' ? ref : undefined });
    return null;
  } catch (e) {
    return e?.message ?? String(e);
  }
}

/** The (cwd, epicId) a kept event row must be in the ledger under, or null. */
function eventEpicKey(row) {
  if (!isPlainObject(row)) return null;
  if (row.kind === 'epic_state_changed') return { cwd: row.cwd, epicId: row.epicId };
  if (row.kind === 'epic_cross_project_reply') return { cwd: row.fromCwd, epicId: row.fromEpicId };
  return null;
}

/** Runs one granted tool. Returns { answer, result } (answer = { status, json }). */
async function runTool(tool, args, { service, invoke, store }) {
  const owns = (cwd, epicId) => typeof cwd === 'string' && cwd !== ''
    && typeof epicId === 'string' && epicId !== ''
    && store.hasOpened(service.serviceId, cwd, epicId) === true;

  switch (tool.name) {
    case 'feedback_open_session': {
      const pinned = { ...args };
      if (pinned.fromCwd === undefined || pinned.fromCwd === null || pinned.fromCwd === '') pinned.fromCwd = service.homeCwd;
      else if (pinned.fromCwd !== service.homeCwd) {
        return {
          answer: { status: 403, json: { ok: false, error: 'fromCwd must be this service\'s home project', homeCwd: service.homeCwd } },
          result: 'refused:fromCwd',
        };
      }
      if (pinned.replyMode === undefined || pinned.replyMode === null) pinned.replyMode = 'event';
      // The service id rides the invoke option (in-process only), never the body.
      const answer = await callInvoke(invoke, tool.toRequest(pinned), { serviceId: service.serviceId });
      const ledgerError = await recordEpic(store, service, answer, pinned.toCwd, pinned.externalRef);
      return { answer, result: isOk(answer) ? 'ok' : `error:${answer.status}`, ledgerError };
    }
    case 'macro_run': {
      const answer = await callInvoke(invoke, tool.toRequest(args));
      const ledgerError = await recordEpic(store, service, answer, args.cwd, args.externalRef);
      return { answer, result: isOk(answer) ? 'ok' : `error:${answer.status}`, ledgerError };
    }
    case 'epic_get': {
      const byId = typeof args.id === 'string' && args.id !== '';
      const hasCwd = typeof args.cwd === 'string' && args.cwd !== '';
      // By id + cwd the ledger is checked first: no route call for someone else's Epic.
      if (byId && hasCwd && !owns(args.cwd, args.id)) return { answer: NOT_FOUND, result: 'refused:ledger' };
      const answer = await callInvoke(invoke, tool.toRequest(args));
      if (isOk(answer)) {
        const epic = answer.json?.epic;
        const epicCwd = typeof epic?.cwd === 'string' && epic.cwd !== '' ? epic.cwd : null;
        // The returned record must be owned under the call's cwd, and under its
        // own cwd when it names one (an id-only call has only the latter).
        const ownedHere = owns(hasCwd ? args.cwd : epicCwd, epic?.epicId);
        const ownedThere = epicCwd === null || owns(epicCwd, epic?.epicId);
        if (!ownedHere || !ownedThere) return { answer: NOT_FOUND, result: 'refused:ledger' };
      }
      return { answer, result: isOk(answer) ? 'ok' : `error:${answer.status}` };
    }
    case 'events_read': {
      const ownsEvent = (row) => { const k = eventEpicKey(row); return k !== null && owns(k.cwd, k.epicId); };
      const answer = await callInvoke(invoke, tool.toRequest(args));
      if (isOk(answer) && Array.isArray(answer.json.events)) {
        const events = answer.json.events.filter((row) => EVENTS_READ_KINDS.includes(row?.kind) && ownsEvent(row));
        return { answer: { status: answer.status, json: { ...answer.json, events } }, result: 'ok' };
      }
      return { answer, result: isOk(answer) ? 'ok' : `error:${answer.status}` };
    }
    case 'project_create': {
      const projectRoot = typeof service.projectRoot === 'string' && service.projectRoot !== '' ? service.projectRoot : null;
      if (projectRoot === null) {
        return {
          answer: { status: 403, json: { ok: false, error: 'this pairing has no approved projects folder; re-pair to grant project_create' } },
          result: 'refused:projectRoot',
        };
      }
      const given = args.parentDir;
      if (given !== undefined && given !== null && given !== ''
        && (typeof given !== 'string' || given.includes('\0') || path.resolve(given) !== projectRoot)) {
        return {
          answer: { status: 403, json: { ok: false, error: 'parentDir must be the projects folder approved at pairing', projectRoot } },
          result: 'refused:parentDir',
        };
      }
      const req = tool.toRequest({ ...args, parentDir: projectRoot });
      req.body = { ...req.body, parentDir: projectRoot, fromCwd: service.homeCwd };
      const answer = await callInvoke(invoke, req);
      return { answer, result: isOk(answer) ? 'ok' : `error:${answer.status}` };
    }
    default: {
      const answer = await callInvoke(invoke, tool.toRequest(args));
      return { answer, result: isOk(answer) ? 'ok' : `error:${answer.status}` };
    }
  }
}

/**
 * @param {any} msg one decoded JSON-RPC message
 * @param {{ service: any, invoke: Function, store: { recordOpened: Function, hasOpened: Function } }} deps
 * @returns {Promise<{ response: any, audit: { tool: string|null, result: string, error?: string } | null }>}
 */
async function handleServiceMcp(msg, { service, invoke, store }) {
  if (!isPlainObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || msg.method === '') {
    const id = isPlainObject(msg) && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
    return { response: rpcError(id, INVALID_REQUEST, 'Invalid Request'), audit: null };
  }
  const hasId = msg.id !== undefined && msg.id !== null;
  if (hasId && typeof msg.id !== 'string' && typeof msg.id !== 'number') {
    return { response: rpcError(null, INVALID_REQUEST, 'Invalid Request: id must be a string or number'), audit: null };
  }
  if (!hasId) return { response: null, audit: null }; // notification: never answered
  const { id, method, params } = msg;
  if (params !== undefined && !isPlainObject(params)) {
    return { response: rpcError(id, INVALID_PARAMS, 'Invalid params: params must be an object'), audit: null };
  }

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return {
        response: rpcResult(id, {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'session-manager', version: appVersion() },
        }),
        audit: null,
      };
    }
    case 'ping':
      return { response: rpcResult(id, {}), audit: null };
    case 'tools/list':
      return {
        response: rpcResult(id, {
          tools: scopedTools(service).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        }),
        audit: null,
      };
    case 'tools/call':
      break;
    default:
      return { response: rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`), audit: null };
  }

  const name = params?.name;
  if (typeof name !== 'string' || name === '') {
    return { response: rpcError(id, INVALID_PARAMS, 'Invalid params: name must be a non-empty string'), audit: null };
  }
  const tool = scopedTools(service).find((t) => t.name === name);
  if (!tool) {
    return {
      response: rpcError(id, SCOPE_REFUSED, `refused: ${name} is not a tool this service may call`),
      audit: { tool: name, result: 'refused:scope' },
    };
  }
  const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
  if (!isPlainObject(args)) {
    return {
      response: rpcError(id, INVALID_PARAMS, 'Invalid params: arguments must be an object'),
      audit: { tool: name, result: 'error:invalid-params' },
    };
  }

  let outcome;
  try {
    outcome = await runTool(tool, args, { service, invoke, store });
  } catch (e) {
    const message = e?.message ?? String(e);
    // toRequest throws on arguments it cannot shape (e.g. an unknown events kind).
    if (/not allowed/.test(message)) {
      return { response: rpcError(id, INVALID_PARAMS, `Invalid params: ${message}`), audit: { tool: name, result: 'error:invalid-params' } };
    }
    return { response: rpcError(id, INTERNAL_ERROR, message), audit: { tool: name, result: 'error:invoke', error: message } };
  }
  const audit = { tool: name, result: outcome.result };
  if (outcome.ledgerError) audit.error = `ledger: ${outcome.ledgerError}`;
  return { response: rpcResult(id, toolResult(outcome.answer)), audit };
}

module.exports = { handleServiceMcp, SCOPE_REFUSED };
