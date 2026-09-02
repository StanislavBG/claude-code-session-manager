#!/usr/bin/env node
/**
 * scheduler-mcp-server.cjs — stdio MCP server wrapping PRD 448's loopback
 * admin HTTP API (src/main/lib/localAdminHttp.cjs). Exposes two tools:
 *
 *   scheduler_reset_job({ slug }) -> POST /admin/scheduler/reset-job
 *   scheduler_list_jobs()         -> GET  /admin/scheduler/jobs
 *
 *   scheduler_create_prd({ ... })  -> POST /admin/scheduler/create-prd
 *
 *   feedback_list_projects()       -> GET  /admin/feedback/targets
 *   feedback_open_session({ ... }) -> POST /admin/feedback/open-session
 *
 *   project_home_get_contract({ cwd? })              -> GET  /admin/project-home/contract
 *   project_home_validate_summary({ cwd?, summary }) -> POST /admin/project-home/validate-summary
 *   project_home_render({ cwd?, summary, picks })    -> POST /admin/project-home/render
 *   project_home_status({ cwd? })                    -> GET  /admin/project-home/status
 *
 * This is a separate process from the Electron app — it only ever reaches
 * it over the token-authed loopback HTTP API in admin-api.json, never by
 * requiring scheduler.cjs/localAdminHttp.cjs directly. The admin server IS the
 * security boundary; this file stays on the client side of it.
 */

'use strict';

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { PRD_WORK_TYPES } = require('../src/main/lib/workTypeLibrary.cjs');
const { MCP_TOOL_CATALOG, MCP_RECIPES, composeDescription } = require('../src/main/lib/mcpToolCatalog.cjs');

const CATALOG_BY_NAME = new Map(MCP_TOOL_CATALOG.map((entry) => [entry.name, entry]));

function descriptionFor(toolName) {
  const entry = CATALOG_BY_NAME.get(toolName);
  if (!entry) throw new Error(`mcpToolCatalog.cjs has no entry for tool "${toolName}"`);
  return composeDescription(entry);
}

const TOKEN_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'admin-api.json');

// Defined once so every failure path points to the same next call, verbatim
// — never paste this sentence at each return site (PRD: session_manager_help).
const HELP_POINTER = ' — call session_manager_help for the correct usage';

function withPointer(text) {
  const str = String(text);
  return str.endsWith(HELP_POINTER) ? str : str + HELP_POINTER;
}

function errorResult(text) {
  return { content: [{ type: 'text', text: withPointer(text) }], isError: true };
}

const NOT_RUNNING_ERROR =
  `session-manager app is not running (admin API unreachable) — start it first${HELP_POINTER}`;

// Same resolution fetchReadiness() below uses: a project-home-builder session
// running inside an Epic worktree still targets the real project cwd, not
// the worktree's own pwd.
function resolveCwdArg(args) {
  if (args && typeof args.cwd === 'string' && args.cwd) return args.cwd;
  return process.env.SM_PROJECT_ROOT || process.cwd();
}

async function readAdminConfig() {
  const raw = await fsp.readFile(TOKEN_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.port !== 'number' || typeof parsed.token !== 'string') {
    throw new Error(NOT_RUNNING_ERROR);
  }
  return parsed;
}

async function adminRequest(method, urlPath, body) {
  let port, token;
  try {
    ({ port, token } = await readAdminConfig());
  } catch {
    throw new Error(NOT_RUNNING_ERROR);
  }
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(NOT_RUNNING_ERROR);
  }
  const json = await res.json();
  return json;
}

// session_manager_help's live half. The catalog/recipes below are static and
// answerable purely in-process (no admin API needed), but "is this MCP
// server actually wired up for THIS project" needs the admin API's
// checkDelegationReadiness result — that's genuinely unavailable when the
// app is down, so this must degrade to a reported-unavailable state rather
// than throwing NOT_RUNNING_ERROR and failing the whole help call.
async function fetchReadiness() {
  // SM_PROJECT_ROOT (when present) is a trusted hint for the real project
  // root — forwarded so a worktree/ops-internal process.cwd() still reports
  // the real project's readiness. See projectRootResolve.cjs.
  const cwd = process.env.SM_PROJECT_ROOT || process.cwd();
  try {
    const qs = new URLSearchParams({ cwd });
    const result = await adminRequest('GET', `/admin/mcp/readiness?${qs.toString()}`);
    if (result?.ok === false) {
      return { available: false, cwd, reason: result.error ?? 'readiness check failed' };
    }
    return { available: true, cwd, ok: result.ready, checks: result.checks };
  } catch (e) {
    return { available: false, cwd, reason: e?.message ?? String(e) };
  }
}

const TOOLS = [
  {
    name: 'scheduler_reset_job',
    description: descriptionFor('scheduler_reset_job'),
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'PRD slug of the job to reset' },
        force: { type: 'boolean', description: 'Required to reset a job whose status is already "completed"' },
        cwd: { type: 'string', description: 'Optional: the PRD project cwd, narrows/speeds the search' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'scheduler_list_jobs',
    description: descriptionFor('scheduler_list_jobs'),
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'scheduler_create_prd',
    description: descriptionFor('scheduler_create_prd'),
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One-line human-readable title' },
        cwd: { type: 'string', description: 'Absolute path to the target project (where claude -p will run). Optional inside an Epic session — the server resolves the real project from the calling session (originClaudeSessionId/sourcePromptId) when omitted.' },
        estimateMinutes: { type: 'number', description: 'Integer wall-clock estimate in minutes' },
        goal: { type: 'string', description: '2-4 sentences: what the executor will build and why' },
        acceptanceCriteria: {
          type: 'array', items: { type: 'string' },
          description: 'Each entry is one verifiable checklist line',
        },
        implementationNotes: { type: 'string', description: 'File paths, patterns, and constraints the executor needs' },
        outOfScope: { type: 'array', items: { type: 'string' }, description: 'Optional: what NOT to build' },
        slug: { type: 'string', description: 'Optional kebab-case slug; derived from title if omitted' },
        parallelGroup: { type: 'number', description: 'DEPRECATED and ignored (PRD 832): numbers are strictly unique per project; use dependsOn for ordering' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Optional: PRD slugs that must complete before this one becomes eligible (replaces the retired shared-NN-parallel convention)' },
        sourcePromptId: { type: 'string', description: "Effectively required: an EXISTING, already-human-approved Epic's promptSessionId (the id shown in the Epics list / active-index.json sessions key) to join — NOT a PromptTicket.id (those are distinct fields). The server never mints a new Epic; if this is omitted and no Epic can be resolved (via the SM_CHAT_SESSION_ID fallback below), the write is refused with an error telling the caller to create/approve an Epic first." },
        sourceTabId: { type: 'string', description: 'Optional: tab id (claudeSessionId) this PRD was queued from, so the scheduler can route a completion status prompt back to it' },
        tag: {
          type: 'string',
          enum: PRD_WORK_TYPES,
          description: 'Optional: the work type of THIS PRD — independent of the parent Epic\'s own tag. An Epic is the plan; a PRD is one unit of work inside it, and a single plan may legitimately contain several different work types. Never derived or inherited from the Epic.',
        },
      },
      required: ['title', 'estimateMinutes', 'goal', 'acceptanceCriteria', 'implementationNotes'],
    },
  },
  {
    name: 'scheduler_list_prds',
    description: descriptionFor('scheduler_list_prds'),
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Optional: only PRDs targeting this project cwd' },
        epicId: { type: 'string', description: 'Optional: only PRDs belonging to this Epic id' },
        status: { type: 'string', description: 'Optional: only PRDs whose job status equals this value' },
        limit: { type: 'number', description: 'Optional: page size, default 100, max 500' },
        offset: { type: 'number', description: 'Optional: page offset, default 0' },
        fields: { type: 'string', enum: ['compact', 'full'], description: 'Optional: "full" restores secondary detail fields; default "compact"' },
      },
    },
  },
  {
    name: 'scheduler_get_prd',
    description: descriptionFor('scheduler_get_prd'),
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'PRD slug to read' },
        cwd: { type: 'string', description: 'Optional: the PRD project cwd, narrows/speeds the search' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'scheduler_update_prd',
    description: descriptionFor('scheduler_update_prd'),
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'PRD slug to edit' },
        cwd: { type: 'string', description: 'Optional: the PRD project cwd, narrows/speeds the search' },
        frontmatter: {
          type: 'object',
          description: 'Partial frontmatter patch — only the keys to change',
          properties: {
            title: { type: 'string' },
            cwd: { type: 'string' },
            estimateMinutes: { type: 'number' },
            parallelGroup: { type: 'number' },
            sourcePromptId: { type: 'string' },
            sourceTabId: { type: 'string' },
            tag: { type: 'string', enum: PRD_WORK_TYPES },
          },
        },
        body: { type: 'string', description: 'Optional: full replacement body (everything after the frontmatter)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'scheduler_archive_prd',
    description: descriptionFor('scheduler_archive_prd'),
    inputSchema: {
      type: 'object',
      properties: {
        slugs: { type: 'array', items: { type: 'string' }, description: 'Slugs to archive' },
        cwd: { type: 'string', description: 'Optional: the PRDs\' project cwd, narrows/speeds the search for every slug in this batch' },
      },
      required: ['slugs'],
    },
  },
  {
    name: 'scheduler_cancel_job',
    description: descriptionFor('scheduler_cancel_job'),
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'PRD slug of the job to cancel' },
        cwd: { type: 'string', description: 'Optional: the PRD project cwd, narrows/speeds the search' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'scheduler_retag_prd',
    description: descriptionFor('scheduler_retag_prd'),
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'One or more retag operations',
          items: {
            type: 'object',
            properties: {
              slug: { type: 'string' },
              parallelGroup: { type: 'number' },
              estimateMinutes: { type: 'number' },
            },
            required: ['slug'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'chat_send_prompt',
    description: descriptionFor('chat_send_prompt'),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Target tab id (claudeSessionId) that must already be open in the app' },
        prompt: { type: 'string', description: 'Prompt text to enqueue' },
      },
      required: ['tabId', 'prompt'],
    },
  },
  {
    name: 'feedback_list_projects',
    description: descriptionFor('feedback_list_projects'),
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'feedback_open_session',
    description: descriptionFor('feedback_open_session'),
    inputSchema: {
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
        body: {
          type: 'string',
          description: 'The report itself: symptom, where observed, expected behavior, suspected cause. Self-contained — the reader cannot see your project.',
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
      },
      required: ['toCwd', 'fromCwd', 'title', 'body'],
    },
  },
  {
    name: 'project_home_get_contract',
    description: descriptionFor('project_home_get_contract'),
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: "Optional: absolute path to the target project. Defaults to the calling session's own project root (SM_PROJECT_ROOT or process.cwd()) when omitted." },
      },
    },
  },
  {
    name: 'project_home_validate_summary',
    description: descriptionFor('project_home_validate_summary'),
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: "Optional: absolute path to the target project. Defaults to the calling session's own project root when omitted." },
        summary: { type: 'object', description: 'ProjectPageSummary object matching the summarySchema from project_home_get_contract' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'project_home_render',
    description: descriptionFor('project_home_render'),
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: "Optional: absolute path to the target project. Defaults to the calling session's own project root when omitted." },
        summary: { type: 'object', description: 'ProjectPageSummary object matching the summarySchema from project_home_get_contract' },
        picks: { type: 'object', description: 'ProjectPagePicks object (lensId -> slotId -> variantId) matching the picksSchema from project_home_get_contract' },
      },
      required: ['summary', 'picks'],
    },
  },
  {
    name: 'project_home_status',
    description: descriptionFor('project_home_status'),
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: "Optional: absolute path to the target project. Defaults to the calling session's own project root when omitted." },
      },
    },
  },
  {
    name: 'session_manager_help',
    description: descriptionFor('session_manager_help'),
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Optional: a tool name — returns that one catalog entry, including exampleArgs' },
        topic: { type: 'string', description: 'Optional: a recipe id — returns that recipe\'s step-by-step instructions' },
      },
    },
  },
];

const server = new Server(
  { name: 'session-manager-scheduler', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Named + exported (see module.exports below) so mcpToolCatalog.test.cjs's
// sibling can exercise session_manager_help's argument handling directly —
// mocking node:fs/promises + global.fetch to drive adminRequest — without
// booting a stdio transport.
async function handleCallTool(request) {
  const { name, arguments: args } = request.params;
  try {
    if (name === 'scheduler_reset_job') {
      const slug = args && typeof args.slug === 'string' ? args.slug : null;
      if (!slug) {
        return errorResult('missing required argument: slug');
      }
      const force = args && args.force === true;
      const cwd = args && typeof args.cwd === 'string' ? args.cwd : undefined;
      const result = await adminRequest('POST', '/admin/scheduler/reset-job', { slug, force, cwd });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'scheduler_list_jobs') {
      const result = await adminRequest('GET', '/admin/scheduler/jobs');
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'scheduler_list_prds') {
      const qs = new URLSearchParams();
      if (args?.cwd) qs.set('cwd', args.cwd);
      if (args?.epicId) qs.set('epicId', args.epicId);
      if (args?.status) qs.set('status', args.status);
      if (args?.limit !== undefined) qs.set('limit', String(args.limit));
      if (args?.offset !== undefined) qs.set('offset', String(args.offset));
      if (args?.fields) qs.set('fields', args.fields);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const result = await adminRequest('GET', `/admin/scheduler/prds${suffix}`);
      // Surface hasMore/total up front so an agent can't mistake a partial
      // page for the full list (the 353KB/120s-timeout incident this
      // pagination exists to fix).
      if (result?.ok && result.hasMore) {
        result.note = `partial list: returned ${result.prds.length} of ${result.total} PRDs (offset ${result.offset}, limit ${result.limit}) — pass a higher offset to see more`;
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'scheduler_get_prd') {
      const slug = args && typeof args.slug === 'string' ? args.slug : null;
      if (!slug) {
        return errorResult('missing required argument: slug');
      }
      const qs = new URLSearchParams({ slug });
      if (args?.cwd) qs.set('cwd', args.cwd);
      const result = await adminRequest('GET', `/admin/scheduler/prd?${qs.toString()}`);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'scheduler_update_prd') {
      const slug = args && typeof args.slug === 'string' ? args.slug : null;
      if (!slug) {
        return errorResult('missing required argument: slug');
      }
      const result = await adminRequest('POST', '/admin/scheduler/update-prd', args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'scheduler_archive_prd') {
      const slugs = Array.isArray(args?.slugs) ? args.slugs : null;
      if (!slugs || slugs.length === 0) {
        return errorResult('missing required argument: slugs');
      }
      const cwd = args && typeof args.cwd === 'string' ? args.cwd : undefined;
      const result = await adminRequest('POST', '/admin/scheduler/archive-prd', { slugs, cwd });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'scheduler_cancel_job') {
      const slug = args && typeof args.slug === 'string' ? args.slug : null;
      if (!slug) {
        return errorResult('missing required argument: slug');
      }
      const cwd = args && typeof args.cwd === 'string' ? args.cwd : undefined;
      const result = await adminRequest('POST', '/admin/scheduler/cancel-job', { slug, cwd });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'scheduler_retag_prd') {
      const items = Array.isArray(args?.items) ? args.items : null;
      if (!items || items.length === 0) {
        return errorResult('missing required argument: items');
      }
      const result = await adminRequest('POST', '/admin/scheduler/retag-prd', { items });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'scheduler_create_prd') {
      // If the caller (the model) didn't pass sourcePromptId, forward this
      // process's own SM_CHAT_SESSION_ID (set by chatRunner.cjs on the
      // parent claude -p process this MCP server inherited its env from) so
      // the admin route can auto-resolve it to the calling Epic and join
      // that Epic instead of silently minting an unrelated sibling one — see
      // prdCreate.cjs's resolveSourcePromptIdFromClaudeSession.
      const payload = { ...args };
      if (!payload.sourcePromptId && process.env.SM_CHAT_SESSION_ID) {
        payload.originClaudeSessionId = process.env.SM_CHAT_SESSION_ID;
      }
      // SM_PROJECT_ROOT (chatRunner.cjs/pty.cjs/scheduler.cjs's job spawn) —
      // a trusted hint for the real project cwd, forwarded so the admin route
      // can resolve it even when the caller omitted cwd or passed a worktree
      // pwd. See projectRootResolve.cjs's resolveProjectContext.
      if (process.env.SM_PROJECT_ROOT) {
        payload.originProjectRoot = process.env.SM_PROJECT_ROOT;
      }
      const result = await adminRequest('POST', '/admin/scheduler/create-prd', payload);
      // Never say "queued" — this tool only writes the PRD file; the queue
      // row is derived by the scheduler's next reconcile pass, not by this
      // call. Say so plainly alongside the raw JSON.
      const note = result?.ok !== false
        ? ' — PRD file written; the queue row is derived on the next scheduler reconcile pass, not by this call.'
        : '';
      return { content: [{ type: 'text', text: JSON.stringify(result) + note }] };
    }
    if (name === 'feedback_list_projects') {
      const result = await adminRequest('GET', '/admin/feedback/targets');
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'feedback_open_session') {
      for (const key of ['toCwd', 'fromCwd', 'title', 'body']) {
        if (!args || typeof args[key] !== 'string' || !args[key].trim()) {
          return errorResult(`missing required argument: ${key}`);
        }
      }
      // Same fallback shape as scheduler_create_prd: forward this process's
      // inherited claude session id so the server can resolve the SENDING
      // Epic and chain a receipt onto it. Never invents an Epic — an
      // unresolvable id just means no receipt.
      const payload = { ...args };
      if (!payload.fromEpicId && process.env.SM_CHAT_SESSION_ID) {
        payload.originClaudeSessionId = process.env.SM_CHAT_SESSION_ID;
      }
      // See scheduler_create_prd's own SM_PROJECT_ROOT forwarding above.
      if (process.env.SM_PROJECT_ROOT) {
        payload.originProjectRoot = process.env.SM_PROJECT_ROOT;
      }
      const result = await adminRequest('POST', '/admin/feedback/open-session', payload);
      // Never say "sent", "filed" or "fixed" — this call delivers a PROPOSAL
      // that a human in the other project must still approve.
      const note = result?.ok !== false
        ? ' — delivered as a PROPOSED session in the receiving project; it runs only if a human there presses Approve & start. No reply channel.'
        : '';
      return { content: [{ type: 'text', text: JSON.stringify(result) + note }] };
    }
    if (name === 'chat_send_prompt') {
      const tabId = args && typeof args.tabId === 'string' ? args.tabId : null;
      const prompt = args && typeof args.prompt === 'string' ? args.prompt : null;
      if (!tabId || !prompt) {
        return errorResult('missing required arguments: tabId, prompt');
      }
      const result = await adminRequest('POST', '/admin/chat/send-prompt', { tabId, prompt });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'project_home_get_contract') {
      const cwd = resolveCwdArg(args);
      const qs = new URLSearchParams({ cwd });
      const result = await adminRequest('GET', `/admin/project-home/contract?${qs.toString()}`);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'project_home_validate_summary') {
      if (!args || typeof args.summary !== 'object' || args.summary === null) {
        return errorResult('missing required argument: summary');
      }
      const cwd = resolveCwdArg(args);
      const result = await adminRequest('POST', '/admin/project-home/validate-summary', { cwd, summary: args.summary });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'project_home_render') {
      if (!args || typeof args.summary !== 'object' || args.summary === null) {
        return errorResult('missing required argument: summary');
      }
      if (typeof args.picks !== 'object' || args.picks === null) {
        return errorResult('missing required argument: picks');
      }
      const cwd = resolveCwdArg(args);
      const result = await adminRequest('POST', '/admin/project-home/render', { cwd, summary: args.summary, picks: args.picks });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'project_home_status') {
      const cwd = resolveCwdArg(args);
      const qs = new URLSearchParams({ cwd });
      const result = await adminRequest('GET', `/admin/project-home/status?${qs.toString()}`);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'session_manager_help') {
      const toolName = args && typeof args.tool === 'string' ? args.tool : null;
      const topic = args && typeof args.topic === 'string' ? args.topic : null;

      const response = {};

      if (toolName) {
        const entry = CATALOG_BY_NAME.get(toolName);
        if (!entry) {
          const valid = MCP_TOOL_CATALOG.map((e) => e.name);
          return errorResult(`unknown tool "${toolName}" for session_manager_help — valid tool names: ${valid.join(', ')}`);
        }
        response.tool = entry;
      }

      if (topic) {
        const recipe = MCP_RECIPES.find((r) => r.id === topic);
        if (!recipe) {
          const valid = MCP_RECIPES.map((r) => r.id);
          return errorResult(`unknown topic "${topic}" for session_manager_help — valid topic ids: ${valid.join(', ')}`);
        }
        response.recipe = recipe;
      }

      if (!toolName && !topic) {
        response.tools = MCP_TOOL_CATALOG.map((e) => ({ name: e.name, group: e.group, purpose: e.purpose }));
        response.recipes = MCP_RECIPES.map((r) => ({ id: r.id, title: r.title }));
      }

      response.readiness = await fetchReadiness();

      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }
    return errorResult(`unknown tool: ${name}`);
  } catch (e) {
    return errorResult(e?.message ?? String(e));
  }
}

server.setRequestHandler(CallToolRequestSchema, handleCallTool);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Guarded so mcpToolCatalog.test.cjs can `require()` this file to read TOOLS
// (for both-directions name-parity) without opening a stdio transport as a
// require-time side effect — only the real `node scripts/scheduler-mcp-server.cjs`
// invocation satisfies require.main === module.
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`scheduler-mcp-server fatal: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
}

module.exports = { TOOLS, handleCallTool, HELP_POINTER, NOT_RUNNING_ERROR };
