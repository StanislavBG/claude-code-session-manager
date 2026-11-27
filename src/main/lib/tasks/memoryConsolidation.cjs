'use strict';

/**
 * memoryConsolidation.cjs — the weekly, per-project md-network Task.
 *
 * For every project whose human switch 'Scripts may run Tasks' is ON, at most
 * once per 7 days (or earlier, at most once per 24 h, while the project's
 * MEMORY.md index is over the health.cjs memory budget) this starts ONE Task
 * through the existing Task start path — POST /admin/tasks on the app's own
 * loopback admin server (switch check, persona → pinned --model/--effort,
 * slot cap, ledger). The Task runs the maintaining-md-network "Weekly
 * consolidation" pass as persona md-network-curator (Fable, max):
 *   - window = [previous counted run's start, now); first run: last 7 days,
 *   - inputs = this project's transcripts and the PRD jobs' Lessons blocks in
 *     the window (weeklyConsolidationInputs.cjs), the memoryStale candidates,
 *     the index size and the optional steering file path,
 *   - output = the record between the PROPOSAL markers.
 * This module posts ONE "Needs you" item (POST /admin/needs-you) whose title
 * carries the counts; the full record stays in the Task body. Nothing is ever
 * deleted or edited: the Task runs read-only (Read, Grep, Glob + the subagent
 * tool); the owner accepts or rejects each change via Review MD network.
 *
 * Cadence state is the Task ledger itself (caller.pipeline ===
 * PIPELINE) — no new ops namespace, no second writer.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const PIPELINE = 'memory-consolidation';
const MISSION_ID = 'memory-consolidation';
const AGENT = 'md-network-curator';
const NEEDS_YOU_APP = 'memory-consolidation';
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const OVER_BUDGET_MIN_GAP_MS = DAY_MS;
const TICK_MS = 60 * 60 * 1000;
const FIRST_TICK_MS = 5 * 60 * 1000;
const MAX_CANDIDATES = 60;
const NEEDS_YOU_WHY_MAX = 1000;
const PROPOSAL_START = '<<<PROPOSAL';
const PROPOSAL_END = 'PROPOSAL>>>';
const SUBAGENT_TOOL = 'Agent';
const READ_ONLY_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', SUBAGENT_TOOL]);
const TASK_TIMEOUT_SEC = 3600;
const FIRST_RUN_WINDOW_MS = WEEK_MS;
const PRIOR_RUN_LOOKBACK_MS = 90 * DAY_MS;
const STEERING_REL = path.join('session-manager-operations', 'md-network', 'steering.md');
const WEEKLY_DOC = 'plugins/session-manager-dev/skills/maintaining-md-network/weekly-consolidation.md';

const NO_DELETE_RULE = 'Do NOT delete, move, rename, edit or create any file. You only propose; the human decides.';

/** cwd → true while a consolidation for it is being started or is running. */
const inFlight = new Set();

/**
 * The Task prompt. Pure.
 * @param {{ cwd: string, memoryDir?: string|null, candidates?: Array<any>, budget?: any, window?: { sinceMs: number, untilMs: number }|null, transcripts?: Array<{ path: string }>, transcriptsTruncated?: number, lessons?: Array<{ slug?: any, jobId?: any, source?: string, lines: string[] }>, steeringPath?: string|null }} o
 * @returns {string}
 */
function buildConsolidationPrompt({ cwd, memoryDir = null, candidates = [], budget = null, window = null, transcripts = [], transcriptsTruncated = 0, lessons = [], steeringPath = null } = /** @type {any} */ ({})) {
  const list = (Array.isArray(candidates) ? candidates : []).slice(0, MAX_CANDIDATES);
  const lines = list.length
    ? list.map((c) => {
      const reasons = Array.isArray(c.reasons) && c.reasons.length ? c.reasons.join('; ') : 'no stale signal';
      const dead = Array.isArray(c.deadRefs) && c.deadRefs.length ? ` dead refs: ${c.deadRefs.slice(0, 5).join(', ')}` : '';
      return `- ${c.name} (age ${c.ageDays ?? '?'} d, inbound links ${c.inboundLinks ?? 0}): ${reasons}.${dead}`;
    }).join('\n')
    : '- (no stale candidates were found)';
  const budgetLine = budget && Number.isFinite(budget.bytes)
    ? `MEMORY.md index: ${budget.bytes} bytes / ${budget.lines} lines (budget ${budget.maxBytes} bytes / ${budget.maxLines} lines)${budget.overBudget ? ' — OVER BUDGET: Claude Code loads only the first 200 lines / 25 KB, so entries past that are invisible.' : '.'}`
    : 'MEMORY.md index size: unknown.';
  const windowLine = window
    ? `Window: [${new Date(window.sinceMs).toISOString()}, ${new Date(window.untilMs).toISOString()}) — half-open; ignore anything outside it.`
    : 'Window: unknown.';
  const tl = Array.isArray(transcripts) ? transcripts : [];
  const transcriptLines = tl.length
    ? tl.map((t) => `- ${t.path}`).join('\n') + (transcriptsTruncated > 0 ? `\n- (+${transcriptsTruncated} more not listed)` : '')
    : '- (no transcripts in the window)';
  const ls = Array.isArray(lessons) ? lessons : [];
  const lessonLines = ls.length
    ? ls.map((l) => `- ${l.slug || l.jobId || 'job'} (${l.source || 'job'}): ${(l.lines || []).join(' | ')}`).join('\n')
    : '- (no Lessons blocks in the window)';

  return [
    `You are running the maintaining-md-network "Weekly consolidation" pass for the project at ${cwd}.`,
    `Follow ${WEEKLY_DOC} (the maintaining-md-network skill) exactly.`,
    '',
    'HARD RULES',
    `1. ${NO_DELETE_RULE}`,
    `2. Use only read tools (Read, Grep, Glob) and the ${SUBAGENT_TOOL} tool for subagents. Never run a shell command, never write.`,
    '3. Your whole answer is the record, ONE document. It is posted as ONE "Needs you" item for the owner; do not split it.',
    '',
    'INPUTS',
    windowLine,
    `Memory folder: ${memoryDir || '(unknown — skip memory files you cannot read)'}`,
    budgetLine,
    'Stale candidates (memoryStale scoreMemories):',
    lines,
    'Session transcripts in the window (read-only):',
    transcriptLines,
    'Lessons blocks from PRD jobs in the window:',
    lessonLines,
    steeringPath ? `Steering file (read it first): ${steeringPath}` : 'Steering file: none.',
    '',
    'OUTPUT — the record from weekly-consolidation.md ("The record"), exactly this, nothing before or after:',
    PROPOSAL_START,
    '<the record: header, Totals: adds N, merges N, removals N, and the change table>',
    PROPOSAL_END,
  ].join('\n');
}

/** { adds, merges, removals } from the record's Totals line, else null. */
function parseTotals(record) {
  const m = /adds\s+(\d+)\s*,\s*merges\s+(\d+)\s*,\s*removals\s+(\d+)/i.exec(String(record || ''));
  return m ? { adds: Number(m[1]), merges: Number(m[2]), removals: Number(m[3]) } : null;
}

/** The table between the markers, else the whole result text, trimmed. */
function extractProposal(text) {
  const s = String(text || '');
  const a = s.indexOf(PROPOSAL_START);
  const b = s.indexOf(PROPOSAL_END, a + 1);
  if (a !== -1 && b !== -1) return s.slice(a + PROPOSAL_START.length, b).trim();
  return s.trim();
}

function cwdKey(cwd) {
  return crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

/** Loopback JSON POST to the app's own admin server (index.cjs passes it). */
function adminPosterFor(adminHttp) {
  return (/** @type {string} */ urlPath, /** @type {any} */ body) => new Promise((resolve, reject) => {
    const server = adminHttp && adminHttp.server;
    const addr = server && typeof server.address === 'function' ? server.address() : null;
    if (!addr || typeof addr !== 'object' || !adminHttp.token) {
      reject(new Error('admin server is not running'));
      return;
    }
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      method: 'POST',
      path: urlPath,
      headers: { Authorization: `Bearer ${adminHttp.token}`, 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* non-JSON reply */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.setTimeout(0);
    req.on('error', reject);
    req.end(data);
  });
}

/**
 * Task statuses (or POST /admin/tasks error codes) for a Task that never ran:
 * refused by the usage hold, or never given a slot. Such a Task does not use
 * up a cadence window.
 */
const NOT_RUN_STATUSES = Object.freeze(['usage_held', 'usage_hold_error', 'slot_timeout', 'too_many_waiting']);

function defaultDeps() {
  return {
    usageHold: () => require('../../scheduler.cjs').currentUsageHold(),
    isTaskSwitchOn: (/** @type {string} */ cwd) => require('./taskSwitch.cjs').isTaskSwitchOn(cwd),
    listTasks: (/** @type {string} */ cwd, /** @type {any} */ o) => require('./taskLedger.cjs').listTasks(cwd, o),
    measureBudget: (/** @type {string} */ cwd) => {
      const health = require('../../health.cjs');
      const m = health.measureProjectMemory(cwd);
      if (!m) return null;
      const budget = health.resolveMemoryBudget();
      const { component } = health.evaluateMemoryBudget([m], budget);
      return { dir: m.dir, bytes: m.bytes, lines: m.lines, maxBytes: budget.maxBytes, maxLines: budget.maxLines, overBudget: component.ok === false };
    },
    staleCandidates: async (/** @type {string} */ cwd) => {
      const r = await require('../../memoryTool.cjs').stale({ cwd });
      return (r && Array.isArray(r.entries) ? r.entries : []).filter((e) => e && e.stale);
    },
    listTranscripts: (/** @type {any} */ o) => require('./weeklyConsolidationInputs.cjs').listProjectTranscripts(o),
    collectLessons: (/** @type {any} */ o) => require('./weeklyConsolidationInputs.cjs').collectLessons(o),
    steeringPath: (/** @type {string} */ cwd) => {
      const p = path.join(cwd, STEERING_REL);
      try { return fs.existsSync(p) ? p : null; } catch { return null; }
    },
  };
}

/** Last consolidation start (ms) within the window, else null. */
async function lastStartMs(listTasks, cwd, sinceMs) {
  const { tasks } = await listTasks(cwd, { pipeline: PIPELINE, since: new Date(sinceMs).toISOString(), limit: 50 });
  const t = (Array.isArray(tasks) ? tasks : []).find((x) => x && !NOT_RUN_STATUSES.includes(x.status));
  const ms = t ? Date.parse(t.startedAt) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Decide and, when due, start one consolidation Task for `cwd`.
 * Resolves { started: false, reason } or { started: true, reason, done } where
 * `done` settles after the Task ran and its Needs you item was posted. Never throws.
 *
 * @param {{ cwd: string, now?: number, deps?: {
 *   usageHold?: () => any,
 *   isTaskSwitchOn?: (cwd: string) => boolean,
 *   listTasks?: (cwd: string, o: any) => Promise<{ tasks: any[] }>,
 *   measureBudget?: (cwd: string) => any,
 *   staleCandidates?: (cwd: string) => Promise<any[]>,
 *   listTranscripts?: (o: any) => any,
 *   collectLessons?: (o: any) => any,
 *   steeringPath?: (cwd: string) => string|null,
 *   adminPost?: (path: string, body: any) => Promise<{ status: number, body: any }>,
 * } }} o
 */
async function maybeStartConsolidation({ cwd, now = Date.now(), deps = {} } = /** @type {any} */ ({})) {
  const d = { ...defaultDeps(), ...deps };
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { started: false, reason: 'invalid_cwd' };
  const key = path.resolve(cwd);
  try {
    if (!d.isTaskSwitchOn(key)) return { started: false, reason: 'switch_off' };
    if (inFlight.has(key)) return { started: false, reason: 'in_flight' };
    if (typeof d.adminPost !== 'function') return { started: false, reason: 'no_admin_server' };
    const hold = d.usageHold();
    if (hold) return { started: false, reason: 'usage_held', hold };

    let budget = null;
    try { budget = d.measureBudget(key); } catch { budget = null; }
    const overBudget = !!(budget && budget.overBudget);

    const last = await lastStartMs(d.listTasks, key, now - WEEK_MS);
    if (last != null) {
      if (!overBudget) return { started: false, reason: 'not_due' };
      if (now - last < OVER_BUDGET_MIN_GAP_MS) return { started: false, reason: 'not_due' };
    }

    let candidates = [];
    try { candidates = await d.staleCandidates(key); } catch { candidates = []; }

    // Window start = the previous counted run's start, so two runs never overlap.
    let prev = last;
    if (prev == null) {
      try { prev = await lastStartMs(d.listTasks, key, now - PRIOR_RUN_LOOKBACK_MS); } catch { prev = null; }
    }
    const window = { sinceMs: prev != null ? prev : now - FIRST_RUN_WINDOW_MS, untilMs: now };
    let tr = { transcripts: [], truncated: 0 };
    try { tr = d.listTranscripts({ cwd: key, sinceMs: window.sinceMs, untilMs: window.untilMs }) || tr; } catch { /* inputs are best-effort */ }
    let ls = { lessons: [] };
    try { ls = d.collectLessons({ cwd: key, sinceMs: window.sinceMs, untilMs: window.untilMs }) || ls; } catch { /* best-effort */ }
    let steeringPath = null;
    try { steeringPath = d.steeringPath(key); } catch { steeringPath = null; }

    const prompt = buildConsolidationPrompt({
      cwd: key, memoryDir: budget ? budget.dir : null, candidates, budget, window,
      transcripts: tr.transcripts, transcriptsTruncated: tr.truncated, lessons: ls.lessons, steeringPath,
    });
    const reason = last == null ? 'weekly' : 'over_budget';
    inFlight.add(key);
    const done = runAndPost({ cwd: key, now, prompt, reason, adminPost: d.adminPost })
      .catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => { inFlight.delete(key); });
    return { started: true, reason, done };
  } catch (e) {
    return { started: false, reason: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

async function runAndPost({ cwd, now, prompt, reason, adminPost }) {
  const runId = `${new Date(now).toISOString().slice(0, 10)}-${cwdKey(cwd)}`;
  const task = await adminPost('/admin/tasks', {
    cwd,
    agent: AGENT,
    missionId: MISSION_ID,
    prompt,
    priority: 'batch',
    timeoutSec: TASK_TIMEOUT_SEC,
    slotWaitSec: 1800,
    caller: { pipeline: PIPELINE, runId, step: reason },
    runtime: {
      outputFormat: 'json',
      tools: [...READ_ONLY_TOOLS],
      allowedTools: [...READ_ONLY_TOOLS],
    },
  });
  const b = task && task.body;
  if (!task || task.status !== 200 || !b || b.ok !== true || b.status !== 'ok') {
    return { ok: false, error: (b && (b.error || b.status)) || `http_${task && task.status}`, taskId: b && b.taskId };
  }
  const resultText = b.envelope && typeof b.envelope.result === 'string' ? b.envelope.result : '';
  const proposal = extractProposal(resultText);
  if (!proposal) return { ok: false, error: 'empty_proposal', taskId: b.taskId };

  const totals = parseTotals(proposal);
  const counts = totals ? `${totals.adds} adds, ${totals.merges} merges, ${totals.removals} removals` : 'counts not stated';
  const why = [
    `Weekly md-network consolidation proposes ${counts}. Nothing was changed.`,
    "To act: press Review MD network with Mode 'Weekly consolidation', then accept or reject each change.",
    `The full record is in Task ${b.taskId} (Scheduler → Tasks, or task_get).`,
  ].join('\n').slice(0, NEEDS_YOU_WHY_MAX);
  const posted = await adminPost('/admin/needs-you', {
    app: NEEDS_YOU_APP,
    id: `memory-consolidation:${runId}`,
    title: `MD network weekly review for ${path.basename(cwd)}: ${counts}`,
    why,
    cwd,
  });
  const ok = !!(posted && posted.status === 200 && posted.body && posted.body.ok);
  return { ok, taskId: b.taskId, needsYou: ok ? posted.body.item : null, error: ok ? undefined : (posted && posted.body && posted.body.error) || 'needs_you_failed' };
}

/**
 * Hourly sweep (first after 5 min) over every project with the switch on.
 * index.cjs calls this once the admin server is up. Returns a stop function.
 * @param {{ adminHttp: any, log?: (msg: string, meta?: any) => void, intervalMs?: number }} o
 */
function startConsolidationTimer({ adminHttp, log = () => {}, intervalMs = TICK_MS }) {
  const adminPost = adminPosterFor(adminHttp);
  const tick = async () => {
    let projects = [];
    try { projects = require('./taskSwitch.cjs').listTaskProjects().filter((p) => p.enabled); } catch { projects = []; }
    for (const p of projects) {
      const r = await maybeStartConsolidation({ cwd: p.cwd, now: Date.now(), deps: { adminPost } });
      if (r.started) {
        log('memory consolidation started', { cwd: p.cwd, reason: r.reason });
        r.done.then((out) => log('memory consolidation finished', { cwd: p.cwd, ...out }));
      } else if (r.reason === 'error') {
        log('memory consolidation check failed', { cwd: p.cwd, error: r.error });
      }
    }
  };
  const safeTick = () => { tick().catch(() => {}); };
  const first = setTimeout(safeTick, FIRST_TICK_MS);
  const every = setInterval(safeTick, intervalMs);
  if (typeof first.unref === 'function') first.unref();
  if (typeof every.unref === 'function') every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}

function _resetForTests() {
  inFlight.clear();
}

module.exports = {
  buildConsolidationPrompt,
  maybeStartConsolidation,
  startConsolidationTimer,
  extractProposal,
  parseTotals,
  AGENT,
  TASK_TIMEOUT_SEC,
  adminPosterFor,
  PIPELINE,
  NO_DELETE_RULE,
  READ_ONLY_TOOLS,
  NOT_RUN_STATUSES,
  _resetForTests,
};
