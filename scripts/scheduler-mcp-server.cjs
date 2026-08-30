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

const TOKEN_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'admin-api.json');

const NOT_RUNNING_ERROR =
  'session-manager app is not running (admin API unreachable) — start it first';

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

const TOOLS = [
  {
    name: 'scheduler_reset_job',
    description: "Reset a stuck scheduler job by slug via the session-manager app's admin API. "
      + 'Refuses a job whose status is already "completed" unless force:true is passed — resetting '
      + 'a completed job re-executes already-shipped work.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'PRD slug of the job to reset' },
        force: { type: 'boolean', description: 'Required to reset a job whose status is already "completed"' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'scheduler_list_jobs',
    description: "List scheduler jobs via the session-manager app's admin API.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'scheduler_create_prd',
    description:
      "THE ONLY SANCTIONED WAY to author a PRD. Write a new PRD file via the session-manager "
      + "app's admin API. Server-side validates the frontmatter, atomically allocates the NN "
      + 'parallel-group number, appends the engineering standards, and writes the PRD file to '
      + "disk. This tool ONLY writes the file — it does not create a scheduler queue row. The "
      + 'queue row is derived automatically by the scheduler\'s next reconcile pass (typically '
      + 'within ~1 minute); the response has `enqueued: false` for exactly this reason. Every '
      + 'PRD must join an EXISTING, already-human-approved Epic (pass sourcePromptId) — this '
      + 'tool never mints a new one, and refuses the write if no Epic can be resolved. '
      + 'TWO DISTINCT FAILURE MODES if this tool is not usable — do not conflate them: '
      + '(a) this tool call is PRESENT in your tool list but ERRORS as app-not-running / admin '
      + 'API unreachable — that is the ONLY case where hand-authoring the PRD file directly on '
      + 'disk is an acceptable DEGRADED, LAST-RESORT fallback; the caller MUST say so explicitly '
      + 'and visibly in its report (which file, why the tool was unreachable, that it needs '
      + 'verification) since the server-side validation, atomic NN allocation, and '
      + 'Epic-existence check this tool performs did not run for that file. '
      + '(b) this tool is ABSENT from your tool list entirely — you were never offered it, so '
      + 'there is no error to catch. That means the session-manager-scheduler MCP server is not '
      + 'registered for this project: a MISCONFIGURATION, not an offline app. In that case DO '
      + 'NOT hand-write any PRD file — stop and tell the human the MCP server is not registered '
      + '(fix: `claude mcp add session-manager-scheduler --scope user -- node '
      + '<session-manager-repo>/scripts/scheduler-mcp-server.cjs`, once at user scope covers '
      + 'every project). See /develop.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One-line human-readable title' },
        cwd: { type: 'string', description: 'Absolute path to the target project (where claude -p will run)' },
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
      required: ['title', 'cwd', 'estimateMinutes', 'goal', 'acceptanceCriteria', 'implementationNotes'],
    },
  },
  {
    name: 'scheduler_list_prds',
    description: "THE ONLY SUPPORTED WAY to list scheduled PRDs (live + archived) via the session-manager app's admin API. "
      + 'Each entry includes its real job status (pending/running/completed/failed/needs_review, or null if not yet '
      + 'queued/reconciled). Optionally filter by project cwd, Epic id, and/or status. Results are paginated (default '
      + 'limit 100, max 500) sorted by slug ascending — check `hasMore`/`total` in the response before assuming you '
      + "received every PRD; page further with `offset`. Default fields are compact (no parallelGroup/estimateMinutes/"
      + 'sourcePromptId/epicId/archivedStatus) — pass fields:"full" to restore them.',
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
    description: "THE ONLY SUPPORTED WAY to read one PRD's full body + parsed frontmatter (live or archived) via the "
      + "session-manager app's admin API.",
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
    description: "THE ONLY SUPPORTED WAY to edit a NOT-yet-running PRD's frontmatter and/or body via the session-manager "
      + 'app\'s admin API. Refuses once a queue row exists for the slug and its status is anything but "pending" '
      + '(running/completed/failed/needs_review) — editing the spec under a live or already-finished executor is refused, '
      + 'not silently applied. Only recognized frontmatter keys (title, cwd, estimateMinutes, parallelGroup, '
      + 'sourcePromptId, sourceTabId, tag) may be patched; unrecognized keys (e.g. dependsOn) round-trip unchanged.',
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
    description: "THE ONLY SUPPORTED WAY to archive one or more PRDs (move to prds-archived/) via the session-manager "
      + "app's admin API.",
    inputSchema: {
      type: 'object',
      properties: {
        slugs: { type: 'array', items: { type: 'string' }, description: 'Slugs to archive' },
      },
      required: ['slugs'],
    },
  },
  {
    name: 'scheduler_cancel_job',
    description: "THE ONLY SUPPORTED WAY to cancel a not-yet-terminal scheduler job via the session-manager app's admin "
      + 'API. A running job is SIGTERM\'d; a pending job is simply retired. There is no "cancelled" job status, so a '
      + 'cancelled job lands as "failed" with an error naming the cause. Refuses a slug whose job is already terminal '
      + '(completed/failed/needs_review) — nothing to cancel.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'PRD slug of the job to cancel' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'scheduler_retag_prd',
    description: "THE ONLY SUPPORTED WAY to rewrite a PRD's parallelGroup and/or estimateMinutes frontmatter (and, if "
      + "parallelGroup changes, its NN- filename prefix) via the session-manager app's admin API.",
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
    description:
      "Push a prompt into an already-open tab's chat queue via the session-manager app's admin "
      + 'API. The renderer resolves the tab (must currently be open) and runs the prompt through '
      + 'the same queued-vs-immediate path as a manual send. No-ops if the tab is unknown/closed.',
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
    description:
      'List the OTHER projects on this machine that can receive feedback (i.e. that Session Manager '
      + 'already manages — they have a session-manager-operations/ directory). Call this FIRST when you '
      + 'need the exact `toCwd` for feedback_open_session and are not certain of it — never guess a path. '
      + 'A project missing from this list has simply never been opened in Session Manager; ask the human '
      + 'to open it once rather than inventing a path.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'feedback_open_session',
    description:
      'THE ONLY SANCTIONED WAY to hand a finding from THIS project to a DIFFERENT project. Opens a new '
      + "PROPOSED session in the receiving project's own Sessions queue, carrying your report as its "
      + 'opening prompt and stamped with where it came from. Session Manager performs the cross-folder '
      + 'write; you never write another project\'s files yourself. '
      + 'WHAT THIS DOES NOT DO: it does not start anything, queue a PRD, or spend a token. The session '
      + 'lands as `proposed` and runs only if a human in the RECEIVING project presses "Approve & start". '
      + 'There is no callback and no reply channel — do not wait for an answer, and do not tell the user '
      + 'the other project has "been fixed" or "is working on it". Report only that the proposal was '
      + 'delivered. '
      + 'WHEN NOT TO USE IT: for work in the project you are ALREADY in, run /develop inside the Epic you '
      + 'are already in — this tool refuses toCwd === fromCwd outright. '
      + 'Write the report for a reader who has never seen your project: state the symptom, where you '
      + 'observed it, what you expected, and (if you know) the file in THEIR repo that looks responsible. '
      + 'Never assume they can see your code.',
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
];

const server = new Server(
  { name: 'session-manager-scheduler', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === 'scheduler_reset_job') {
      const slug = args && typeof args.slug === 'string' ? args.slug : null;
      if (!slug) {
        return { content: [{ type: 'text', text: 'missing required argument: slug' }], isError: true };
      }
      const force = args && args.force === true;
      const result = await adminRequest('POST', '/admin/scheduler/reset-job', { slug, force });
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
        return { content: [{ type: 'text', text: 'missing required argument: slug' }], isError: true };
      }
      const qs = new URLSearchParams({ slug });
      if (args?.cwd) qs.set('cwd', args.cwd);
      const result = await adminRequest('GET', `/admin/scheduler/prd?${qs.toString()}`);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'scheduler_update_prd') {
      const slug = args && typeof args.slug === 'string' ? args.slug : null;
      if (!slug) {
        return { content: [{ type: 'text', text: 'missing required argument: slug' }], isError: true };
      }
      const result = await adminRequest('POST', '/admin/scheduler/update-prd', args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'scheduler_archive_prd') {
      const slugs = Array.isArray(args?.slugs) ? args.slugs : null;
      if (!slugs || slugs.length === 0) {
        return { content: [{ type: 'text', text: 'missing required argument: slugs' }], isError: true };
      }
      const result = await adminRequest('POST', '/admin/scheduler/archive-prd', { slugs });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'scheduler_cancel_job') {
      const slug = args && typeof args.slug === 'string' ? args.slug : null;
      if (!slug) {
        return { content: [{ type: 'text', text: 'missing required argument: slug' }], isError: true };
      }
      const result = await adminRequest('POST', '/admin/scheduler/cancel-job', { slug });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'scheduler_retag_prd') {
      const items = Array.isArray(args?.items) ? args.items : null;
      if (!items || items.length === 0) {
        return { content: [{ type: 'text', text: 'missing required argument: items' }], isError: true };
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
          return { content: [{ type: 'text', text: `missing required argument: ${key}` }], isError: true };
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
        return { content: [{ type: 'text', text: 'missing required arguments: tabId, prompt' }], isError: true };
      }
      const result = await adminRequest('POST', '/admin/chat/send-prompt', { tabId, prompt });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  } catch (e) {
    return { content: [{ type: 'text', text: e?.message ?? String(e) }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`scheduler-mcp-server fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
