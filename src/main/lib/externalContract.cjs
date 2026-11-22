/**
 * externalContract.cjs — sole owner of the outside-contract version number.
 *
 * RULE: a change that breaks an outside caller of an admin route, an MCP
 * tool, an audit event or the admin-api.json shape increments
 * CONTRACT_VERSION. Additive changes (a new route, a new optional field) do
 * not.
 *
 * Why top-level lib/: the contract spans the admin HTTP transport, the MCP
 * server, the audit log and the token file — no single domain subfolder owns
 * it. Outside apps read the number (health route, unknown-route 404,
 * admin-api.json) instead of probing for a missing route.
 */

'use strict';

const CONTRACT_VERSION = 1;

// Read once; null when package.json is unreadable.
let APP_VERSION = null;
try { APP_VERSION = require('../../../package.json').version || null; } catch { APP_VERSION = null; }

/** @returns {{ contractVersion: number, appVersion: string | null }} */
function contractInfo() {
  return { contractVersion: CONTRACT_VERSION, appVersion: APP_VERSION };
}

/** Recursively freeze a plain object/array literal. */
function deepFreeze(v) {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) deepFreeze(v[k]);
    Object.freeze(v);
  }
  return v;
}

/**
 * The outside contract — what an outside app may depend on. Every list here
 * is checked against the code by src/main/__tests__/externalContract.shape.test.cjs;
 * changing one changes contractFingerprint(), which must then be recorded
 * under a new CONTRACT_VERSION in CONTRACT_FINGERPRINTS.
 */
const CONTRACT = deepFreeze({
  routes: [
    { method: 'GET', path: '/__admin/health' },
    { method: 'POST', path: '/admin/feedback/open-session' },
    { method: 'POST', path: '/admin/macros/run' },
    { method: 'GET', path: '/admin/epics' },
    { method: 'GET', path: '/admin/epic' },
    { method: 'GET', path: '/admin/events' },
  ],
  tools: {
    feedback_open_session: { required: ['toCwd', 'fromCwd', 'title', 'motivation', 'acceptanceCriteria', 'body'] },
    epic_list: { required: ['cwd'] },
    epic_get: { required: ['cwd'], requiredOneOf: [['id', 'externalRef']] },
    feedback_reply: { required: ['message', 'outcome'] },
  },
  epicStates: ['closed', 'awaiting_approval', 'needs_input', 'blocked', 'working', 'in_review', 'verified', 'open'],
  epicRecordFields: [
    'epicId', 'cwd', 'title', 'goal', 'tag', 'agentType', 'status', 'state', 'blocked', 'prds',
    'verified', 'refuted', 'unvalidated', 'externalRef', 'source', 'createdAt', 'completedAt',
  ],
  receiptFields: ['jobs', 'chat'],
  epicStateChangedFields: ['at', 'kind', 'cwd', 'epicId', 'from', 'to', 'blockedKind', 'externalRef'],
  // Keys of an event-mode epic_cross_project_reply row (crossProjectReply.cjs replyAsEvent) as readEventsAfter returns it.
  replyEventFields: [
    'at', 'kind', 'cwd', 'epicId', 'fromCwd', 'fromEpicId', 'outcome', 'delivery', 'mode', 'externalRef',
    'message', 'referencePaths',
  ],
  eventKinds: ['epic_state_changed', 'job_transition', 'epic_cross_project_reply'],
  adminApiFields: ['port', 'token', 'appVersion', 'contractVersion'],
});

/** JSON with object keys sorted at every level (arrays keep their order). */
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** @returns {string} sha256 hex of the manifest in stable key order. */
function contractFingerprint() {
  return require('node:crypto').createHash('sha256').update(stableStringify(CONTRACT)).digest('hex');
}

/** Fingerprint recorded for each contract version. */
const CONTRACT_FINGERPRINTS = Object.freeze({
  // v1 was unreleased when the manifest was completed (at/kind, epic_get requiredOneOf, then epic_cross_project_reply + feedback_reply + replyEventFields), so its fingerprint was replaced, not bumped.
  1: '8056c0386a184916e0b6f5d727353cfec95217a4e802f368c6f1ef852a104cf3',
});

module.exports = { CONTRACT_VERSION, contractInfo, CONTRACT, contractFingerprint, CONTRACT_FINGERPRINTS };
