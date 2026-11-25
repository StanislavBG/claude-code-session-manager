/**
 * serviceMcpTools.cjs — the MCP tools a paired service (servicePairings.cjs)
 * may call over the Web Remote relay: one entry per SERVICE_TOOL_NAMES name,
 * each { name, description, inputSchema, toRequest(args) } where toRequest
 * maps the call onto the loopback admin route it mirrors:
 *
 *   feedback_list_projects()                -> GET  /admin/feedback/targets
 *   feedback_open_session({ ... })          -> POST /admin/feedback/open-session
 *   macro_list({ cwd? })                    -> GET  /admin/macros?cwd=
 *   macro_run({ cwd, id, inputs?, effort?, externalRef? }) -> POST /admin/macros/run
 *   epic_get({ cwd, id | externalRef, receipt? }) -> GET /admin/epic?cwd=&id=|externalRef=&receipt=1
 *   events_read({ after?, kinds?, limit? }) -> GET  /admin/events?after=&kinds=&limit=
 *   project_create({ name, externalRef, github?, parentDir? }) -> POST /admin/projects/create
 *
 * The four tools the stdio server (scripts/scheduler-mcp-server.cjs) also
 * serves share their inputSchema OBJECTS with it — that server imports them
 * from here, so a service and a local agent see the same names and schemas.
 * Their descriptions come from mcpToolCatalog.cjs via composeDescription.
 *
 * macro_run, events_read and project_create are SERVICE-ONLY in v1: they are not catalog
 * entries (the external-contract fingerprint stays put) and the stdio server
 * never registers them — a local agent keeps no Epic-starting tool
 * (SINGLE-CREATOR law). No inputSchema uses a top-level oneOf/anyOf (the
 * Claude API refuses those); "exactly one of" rules stay in the handler/route.
 *
 * toRequest only shapes a request; it does not validate (the admin route does).
 * Plain CJS, no Electron dependency — scripts may require it; it requires no
 * script.
 */
'use strict';

const { MCP_TOOL_CATALOG, composeDescription } = require('../mcpToolCatalog.cjs');
const { SERVICE_TOOL_NAMES } = require('./servicePairings.cjs');

const FEEDBACK_LIST_PROJECTS_INPUT_SCHEMA = { type: 'object', properties: {} };

const FEEDBACK_OPEN_SESSION_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    toCwd: {
      type: 'string',
      description: 'Absolute cwd of the RECEIVING project. Must already be a Session Manager project — use feedback_list_projects if unsure.',
    },
    fromCwd: {
      type: 'string',
      description: 'Absolute cwd of YOUR project (the sender). Must differ from toCwd.',
    },
    title: { type: 'string', description: 'One line naming the finding — becomes the receiving queue row' },
    motivation: {
      type: 'string',
      description: 'WHY this is needed, in the originating human\'s terms (max 2000 chars). Lead with this — the approving human reads it first. When a request is split into a series, summarise the overall plan here.',
    },
    plan: {
      type: 'array', items: { type: 'string' },
      description: "Ordered proposed steps (max 20). REQUIRED when tag is 'feature'.",
    },
    acceptanceCriteria: {
      type: 'array', items: { type: 'string' },
      description: 'How the receiving human will know this is done (1-20 items).',
    },
    outOfScope: {
      type: 'array', items: { type: 'string' },
      description: 'Optional: what this proposal deliberately does not cover (max 20).',
    },
    series: {
      type: 'object',
      description: 'Optional: set on EVERY proposal when one request is split into several. Share the same key/title/total across them; index is this proposal\'s position.',
      properties: {
        key: { type: 'string', description: 'Shared kebab-case series id (max 60 chars)' },
        title: { type: 'string', description: 'Shared series title (max 120 chars)' },
        index: { type: 'integer', description: 'This proposal\'s 1-based position in the series' },
        total: { type: 'integer', description: 'Number of proposals in the series (2-50)' },
      },
      required: ['key', 'title', 'index', 'total'],
    },
    body: {
      type: 'string',
      description: 'Supporting detail: evidence, symptom, where observed, references. Self-contained — the reader cannot see your project — but no longer the whole report; motivation/plan/acceptanceCriteria carry the proposal.',
    },
    tag: {
      type: 'string',
      enum: ['bug', 'feature', 'discussion'],
      description: "Mission tag for the receiving session. Defaults to 'discussion' — the tag that keeps /develop available but never assumed, correct for a finding the receiving project has not yet agreed with.",
    },
    fromEpicId: {
      type: 'string',
      description: 'Optional: your own Epic/session id, so a receipt is chained onto your session and the receiving human can see which session is asking. Auto-filled from this process when omitted.',
    },
    agentType: { type: 'string', description: "Optional persona for the receiving session. Defaults to 'architect'." },
    referencePaths: {
      type: 'array', items: { type: 'string' },
      description: 'Optional absolute paths worth reading, appended as Reference lines',
    },
    autoStart: {
      type: 'boolean',
      description: 'Set true ONLY when the human in THIS conversation explicitly asked for this work in the other project. Requires humanRequestQuote. Never set it for work you decided on your own initiative. An unverified request silently falls back to a plain PROPOSED session.',
    },
    humanRequestQuote: {
      type: 'string',
      description: "Required with autoStart. Copy VERBATIM from the human's own message in this conversation; the quoted words themselves must name the target project. Do not paraphrase or write it yourself.",
    },
    externalRef: {
      type: 'string',
      description: 'Optional: your own id for this handoff, 1 to 200 characters of letters, digits or . _ : / @ - (trimmed). It is stored on the new session and returned. Repeating a call with the same toCwd, fromCwd and externalRef opens nothing new and returns the session that already exists (status "existing", existing: true); the same externalRef already used by a different sender is refused with 409.',
    },
    replyMode: {
      type: 'string',
      enum: ['prompt', 'event'],
      description: "Optional: how a reply comes back — 'prompt' (default) wakes your chat session, 'event' records it as data in the audit log for a caller with no chat.",
    },
  },
  required: ['toCwd', 'fromCwd', 'title', 'motivation', 'acceptanceCriteria', 'body'],
};

const MACRO_LIST_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    cwd: { type: 'string', description: "Optional: absolute path to the target project. Defaults to the calling session's own project root (SM_PROJECT_ROOT or process.cwd()) when omitted." },
  },
};

const EPIC_GET_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    cwd: { type: 'string', description: 'Absolute path of the project the Epic belongs to' },
    id: { type: 'string', description: 'The Epic id. Give exactly one of id / externalRef.' },
    externalRef: { type: 'string', description: 'The external reference the Epic was opened with. Give exactly one of id / externalRef.' },
    receipt: { type: 'boolean', description: 'Optional: when true, the answer also carries epic.receipt, what the Epic cost in jobs and chat.' },
  },
  required: ['cwd'],
};

const MACRO_RUN_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    cwd: { type: 'string', description: 'Absolute path of the project the macro belongs to.' },
    id: { type: 'string', description: "The macro id (from macro_list). Only a macro a human ticked 'Can be started by a script' on can be run." },
    inputs: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: "Optional: values for the macro's {{inputs}}, overlaid on its saved defaults.",
    },
    effort: { type: 'string', description: 'Optional: reasoning effort for the started session (one of the PRD effort levels).' },
    externalRef: {
      type: 'string',
      description: 'Optional: your own id for this run (e.g. a date). The macro starts at most once per ref; a repeat answers with the Epic that already exists.',
    },
  },
  required: ['cwd', 'id'],
};

const EVENTS_READ_KINDS = Object.freeze(['epic_state_changed', 'epic_cross_project_reply']);

const EVENTS_READ_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    after: {
      type: 'string',
      description: "Optional: the `next` cursor from your previous call, or 'start' to read from the first kept row. Omit to get no events and a `next` meaning 'from now'.",
    },
    kinds: {
      type: 'array',
      items: { type: 'string', enum: [...EVENTS_READ_KINDS] },
      description: 'Optional: event kinds to return. Defaults to epic_state_changed.',
    },
    limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Optional: page size, 1-500 (default 100).' },
  },
};

const PROJECT_CREATE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Folder name of the new project (becomes <projects folder>/<name>).' },
    externalRef: {
      type: 'string',
      description: 'Your own id for this project. A repeat call with the same externalRef creates nothing new and answers status existing.',
    },
    github: {
      type: 'object',
      description: 'Optional: also create a GitHub repo and set it as origin.',
      properties: {
        private: { type: 'boolean', description: 'Create the repo private (true).' },
        owner: { type: 'string', description: 'Optional: GitHub user or org to own the repo; defaults to the signed-in account.' },
      },
    },
    parentDir: {
      type: 'string',
      description: 'Optional: the projects folder. Only the folder the owner approved at pairing is accepted; omit it to use that folder.',
    },
  },
  required: ['name', 'externalRef'],
};

const CATALOG_BY_NAME = new Map(MCP_TOOL_CATALOG.map((entry) => [entry.name, entry]));

function catalogDescription(name) {
  const entry = CATALOG_BY_NAME.get(name);
  if (!entry) throw new Error(`mcpToolCatalog.cjs has no entry for tool "${name}"`);
  return composeDescription(entry);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v !== '';
}

const SERVICE_TOOLS = Object.freeze([
  {
    name: 'feedback_list_projects',
    description: catalogDescription('feedback_list_projects'),
    inputSchema: FEEDBACK_LIST_PROJECTS_INPUT_SCHEMA,
    toRequest: () => ({ method: 'GET', path: '/admin/feedback/targets' }),
  },
  {
    name: 'feedback_open_session',
    description: catalogDescription('feedback_open_session'),
    inputSchema: FEEDBACK_OPEN_SESSION_INPUT_SCHEMA,
    // Same body the stdio handler sends minus its env-derived identity: a
    // caller-supplied originClaudeSessionId / originProjectRoot is dropped,
    // since only a local process's own env may vouch for a session.
    toRequest: (args) => {
      const body = { ...(args ?? {}) };
      delete body.originClaudeSessionId;
      delete body.originProjectRoot;
      return { method: 'POST', path: '/admin/feedback/open-session', body };
    },
  },
  {
    name: 'macro_list',
    description: catalogDescription('macro_list'),
    inputSchema: MACRO_LIST_INPUT_SCHEMA,
    toRequest: (args) => {
      const query = {};
      if (isNonEmptyString(args?.cwd)) query.cwd = args.cwd;
      return { method: 'GET', path: '/admin/macros', query };
    },
  },
  {
    name: 'macro_run',
    description: 'Start one of a project\'s saved macros (hot keys) as a new Session, the way a human press would. '
      + "Only a macro a human ticked 'Can be started by a script' on can be run; while that macro's Epic is still running "
      + 'it answers with that Epic (alreadyRunning: true) instead of starting a second one. Pass externalRef to start it at '
      + 'most once per ref. Answer: { ok, epicId, alreadyRunning, externalRef? }; follow it with epic_get / events_read.',
    inputSchema: MACRO_RUN_INPUT_SCHEMA,
    toRequest: (args) => {
      const body = { cwd: args?.cwd, id: args?.id };
      if (args?.inputs !== undefined) body.inputs = args.inputs;
      if (args?.effort !== undefined) body.effort = args.effort;
      if (args?.externalRef !== undefined) body.externalRef = args.externalRef;
      return { method: 'POST', path: '/admin/macros/run', body };
    },
  },
  {
    name: 'epic_get',
    description: catalogDescription('epic_get'),
    inputSchema: EPIC_GET_INPUT_SCHEMA,
    // Mirrors the stdio handler: cwd, then id (preferred) or externalRef,
    // then receipt=1. The "exactly one of" refusal stays with the caller/route.
    toRequest: (args) => {
      const query = {};
      if (args?.cwd) query.cwd = args.cwd;
      if (isNonEmptyString(args?.id)) query.id = args.id;
      else if (isNonEmptyString(args?.externalRef)) query.externalRef = args.externalRef;
      if (args?.receipt === true) query.receipt = '1';
      return { method: 'GET', path: '/admin/epic', query };
    },
  },
  {
    name: 'events_read',
    description: 'Read Epic state changes and cross-project replies after a saved cursor, oldest first. '
      + 'Answer: { ok, events, next, more, gap } — save `next` and send it as `after` next time; call again at once while '
      + '`more` is true; on `gap: true` re-read the Epics you follow with epic_get. kinds: epic_state_changed (default), '
      + 'epic_cross_project_reply.',
    inputSchema: EVENTS_READ_INPUT_SCHEMA,
    toRequest: (args) => {
      const query = {};
      if (isNonEmptyString(args?.after)) query.after = args.after;
      if (Array.isArray(args?.kinds) && args.kinds.length > 0) {
        const bad = args.kinds.filter((k) => !EVENTS_READ_KINDS.includes(k));
        if (bad.length > 0) throw new Error(`events_read: kinds not allowed for a service: ${bad.join(', ')}`);
        query.kinds = args.kinds.join(',');
      }
      if (args?.limit !== undefined) query.limit = String(args.limit);
      return { method: 'GET', path: '/admin/events', query };
    },
  },
  {
    name: 'project_create',
    description: 'Create a new project folder in the projects folder the owner approved at pairing: git with one empty '
      + 'commit, the Session Manager operations root, and optionally a private GitHub repo (github: { private: true }) set '
      + 'as origin. Idempotent by externalRef: a repeat answers status existing with the same cwd and repo. Then open its '
      + 'first session with feedback_open_session (toCwd = cwd). Answer: { ok, status, cwd, name, externalRef, repo, github? }.',
    inputSchema: PROJECT_CREATE_INPUT_SCHEMA,
    toRequest: (args) => {
      const body = { name: args?.name, externalRef: args?.externalRef };
      if (args?.github !== undefined) body.github = args.github;
      if (args?.parentDir !== undefined) body.parentDir = args.parentDir;
      return { method: 'POST', path: '/admin/projects/create', body };
    },
  },
].map((tool) => Object.freeze(tool)));

// Fail at require time if the tool list and the pairing grant list drift.
{
  const names = SERVICE_TOOLS.map((t) => t.name);
  if (names.length !== SERVICE_TOOL_NAMES.length || SERVICE_TOOL_NAMES.some((n) => !names.includes(n))) {
    throw new Error(`serviceMcpTools: SERVICE_TOOLS (${names.join(', ')}) != SERVICE_TOOL_NAMES (${SERVICE_TOOL_NAMES.join(', ')})`);
  }
}

/** Names served only to a paired service, never by the local stdio server. */
const SERVICE_ONLY_TOOL_NAMES = Object.freeze(['macro_run', 'events_read', 'project_create']);

module.exports = {
  SERVICE_TOOLS,
  SERVICE_ONLY_TOOL_NAMES,
  EVENTS_READ_KINDS,
  FEEDBACK_LIST_PROJECTS_INPUT_SCHEMA,
  FEEDBACK_OPEN_SESSION_INPUT_SCHEMA,
  MACRO_LIST_INPUT_SCHEMA,
  EPIC_GET_INPUT_SCHEMA,
  MACRO_RUN_INPUT_SCHEMA,
  EVENTS_READ_INPUT_SCHEMA,
  PROJECT_CREATE_INPUT_SCHEMA,
};
