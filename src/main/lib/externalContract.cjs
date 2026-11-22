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
 * in CONTRACT_FINGERPRINTS (see the rule there).
 */
const CONTRACT = deepFreeze({
  routes: [
    { method: 'GET', path: '/__admin/health' },
    { method: 'POST', path: '/admin/feedback/open-session' },
    { method: 'POST', path: '/admin/macros/run' },
    { method: 'GET', path: '/admin/epics' },
    { method: 'GET', path: '/admin/epic' },
    { method: 'GET', path: '/admin/events' },
    { method: 'GET', path: '/admin/agents' },
    { method: 'POST', path: '/admin/needs-you' },
    { method: 'POST', path: '/admin/needs-you/withdraw' },
    { method: 'GET', path: '/admin/needs-you' },
    { method: 'POST', path: '/admin/tasks' },
    { method: 'GET', path: '/admin/tasks' },
    { method: 'GET', path: '/admin/task' },
    { method: 'POST', path: '/admin/tasks/import' },
    { method: 'GET', path: '/admin/validation-quality' },
  ],
  tools: {
    feedback_open_session: { required: ['toCwd', 'fromCwd', 'title', 'motivation', 'acceptanceCriteria', 'body'] },
    epic_list: { required: ['cwd'] },
    epic_get: { required: ['cwd'], requiredOneOf: [['id', 'externalRef']] },
    feedback_reply: { required: ['message', 'outcome'] },
    agent_list: { required: [] },
    task_list: { required: ['cwd'] },
    task_get: { required: ['cwd', 'id'] },
  },
  epicStates: ['closed', 'awaiting_approval', 'needs_input', 'blocked', 'working', 'in_review', 'verified', 'open'],
  epicRecordFields: [
    'epicId', 'cwd', 'title', 'goal', 'tag', 'agentType', 'status', 'state', 'blocked', 'prds',
    'verified', 'refuted', 'unvalidated', 'externalRef', 'source', 'createdAt', 'completedAt', 'verdicts',
  ],
  receiptFields: ['jobs', 'chat'],
  epicStateChangedFields: ['at', 'kind', 'cwd', 'epicId', 'from', 'to', 'blockedKind', 'externalRef'],
  // Keys of an event-mode epic_cross_project_reply row (crossProjectReply.cjs replyAsEvent) as readEventsAfter returns it.
  replyEventFields: [
    'at', 'kind', 'cwd', 'epicId', 'fromCwd', 'fromEpicId', 'outcome', 'delivery', 'mode', 'externalRef',
    'message', 'referencePaths',
  ],
  // Keys of one agent in GET /admin/agents?cwd=… (agentAdminRoutes.cjs publicAgent + resolved).
  agentFields: [
    'name', 'title', 'description', 'model', 'effort', 'tags', 'tools', 'executorOnly', 'agentCli', 'agentCliModel',
    'seedVersion', 'path', 'resolved',
  ],
  // Keys of one stored Needs you item (feedback-remote/needsYouStore.cjs) as the store and GET /admin/needs-you return it.
  needsYouItemFields: [
    'app', 'id', 'title', 'why', 'link', 'options', 'externalRef', 'status', 'answer', 'createdAt', 'updatedAt',
    'answeredAt',
  ],
  // Keys of a needs_you_answered row (feedback-remote/needsYouIpc.cjs) as readEventsAfter returns it; externalRef only when the item has one.
  needsYouAnsweredFields: ['at', 'kind', 'app', 'id', 'answer', 'externalRef'],
  // Keys of one Task in GET /admin/tasks (tasks/taskAdminRoutes.cjs TASK_FIELDS); GET /admin/task adds the text fields.
  taskFields: [
    'taskId', 'source', 'importId', 'importedAt', 'agent', 'missionId', 'model', 'effort', 'priority', 'caller',
    'outputFormat', 'timeoutSec', 'slotWaitSec', 'sessionId', 'persisted', 'startedAt', 'endedAt', 'status',
    'exitCode', 'signal', 'durationMs', 'slotWaitMs', 'usage', 'costUsd', 'cliCostUsd', 'numTurns', 'quota',
    'promptBytes', 'promptSha256', 'outputBytes', 'outputSha256',
  ],
  eventKinds: ['epic_state_changed', 'job_transition', 'epic_cross_project_reply', 'needs_you_answered'],
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

/**
 * Accepted fingerprints for each contract version, oldest first; the last
 * entry of CONTRACT_FINGERPRINTS[CONTRACT_VERSION] is the current manifest.
 * - An additive change (a new route, a new optional field) appends its
 *   fingerprint to the current version's array; contractVersion stays.
 * - A breaking change increments CONTRACT_VERSION and starts a new array.
 */
const CONTRACT_FINGERPRINTS = Object.freeze({
  // v1 was unreleased when the manifest was completed (at/kind, epic_get requiredOneOf, then epic_cross_project_reply + feedback_reply + replyEventFields, then GET /admin/agents + agent_list + agentFields, then the Needs you routes + needsYouItemFields + needsYouAnsweredFields + needs_you_answered, then POST /admin/tasks, then GET /admin/tasks + GET /admin/task + POST /admin/tasks/import + taskFields, then task_list + task_get), so its first fingerprint was replaced, not appended.
  // Additive since: epicRecordFields + 'verdicts' (checked validator verdicts from plan-records/*.verdicts.json),
  // then GET /admin/validation-quality (validationQualityHandlers.cjs).
  1: Object.freeze([
    '5a56abbb70184ff4a34346a5c6da4c5e6edbd756b54573c199b812d3f5a04101',
    '7383ff32c80561b1b2c505a78a1e8313ae2851bdc6e8fce6c6a88e1ab119bf5a',
    'b8af6788f3c5022346278194a8113455c47f3ab7a565e51d47c5e79c7f36fbd7',
  ]),
});

module.exports = { CONTRACT_VERSION, contractInfo, CONTRACT, contractFingerprint, CONTRACT_FINGERPRINTS };
