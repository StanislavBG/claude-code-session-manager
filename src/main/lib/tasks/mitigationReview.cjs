'use strict';

/**
 * mitigationReview.cjs — re-test the model-mitigations registry when the
 * default executor model changes.
 *
 * The registry (session-manager-operations/architecture/model-mitigations.md)
 * lists every rule that exists only to work around how a model behaves. When
 * the default executor model id changes, some rows may no longer be needed.
 *
 * For every project whose human switch 'Scripts may run Tasks' is ON and that
 * carries the registry file, an hourly tick:
 *   1. resolves the default executor model id — the dev-lead persona's model
 *      (overlay-aware), else the Settings model, else agentModelResolve's
 *      FALLBACK_MODEL; an alias is mapped to the newest concrete id of its
 *      family that modelCatalog found in the CLI binary;
 *   2. compares it with the last-seen id recorded per project in
 *      ~/.claude/session-manager/mitigation-review.json (machine-global app
 *      state, not an ops namespace — like model-catalog.json);
 *   3. on a change, records the new id and starts ONE review Task through the
 *      existing Task start path (POST /admin/tasks: switch check, persona →
 *      pinned --model/--effort, slot cap, ledger). Its prompt lists every
 *      registry row; it runs read-only (Read, Grep, Glob) as dev-lead, i.e. on
 *      the new default model itself, and answers with ONE keep/remove table;
 *   4. posts that table as ONE "Needs you" item (POST /admin/needs-you).
 * Nothing is edited: the human decides which rows (and rules) to retire.
 * The first sighting only records the id (no previous model → no change).
 * With the switch off nothing is recorded, so a change seen while off is still
 * reviewed once the switch is turned on.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { adminPosterFor, extractProposal, NOT_RUN_STATUSES } = require('./memoryConsolidation.cjs');
const { OPS_ROOT_DIR } = require('../opsOwnership.cjs');

const PIPELINE = 'mitigation-review';
const MISSION_ID = 'mitigation-review';
const AGENT = 'dev-lead';
const NEEDS_YOU_APP = 'mitigation-review';
const REGISTRY_REL = path.join(OPS_ROOT_DIR, 'architecture', 'model-mitigations.md');
const STATE_FILE = 'mitigation-review.json';
const TICK_MS = 60 * 60 * 1000;
const FIRST_TICK_MS = 10 * 60 * 1000;
const NEEDS_YOU_WHY_MAX = 1000;
const PROPOSAL_START = '<<<PROPOSAL';
const PROPOSAL_END = 'PROPOSAL>>>';
const READ_ONLY_TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);
const NO_EDIT_RULE = 'Do NOT delete, edit, move or create any file. You only propose; the human decides.';

/** cwd → true while a review for it is being started or is running. */
const inFlight = new Set();

const stripTicks = (s) => String(s || '').trim().replace(/^`+|`+$/g, '').trim();

/**
 * Registry table rows (`| MM-<n> | behavior | model | observed | location | needle |`). Pure.
 * @param {string} text
 */
function parseRegistryRows(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 6 || !/^MM-\d+$/.test(cells[0])) continue;
    rows.push({
      id: cells[0],
      behavior: cells[1],
      model: cells[2],
      observed: cells[3],
      location: stripTicks(cells[4]),
      needle: stripTicks(cells[5]),
    });
  }
  return rows;
}

/** Numeric version segments of `claude-<family>-N-M[-YYYYMMDD]` (date suffix dropped). */
function versionOf(id, family) {
  return id.slice(`claude-${family}-`.length).split('-')
    .filter((s) => /^\d+$/.test(s) && s.length < 8)
    .map(Number);
}

/**
 * An alias (`sonnet`) → the newest concrete id of that family in `ids`; a
 * concrete id, or an alias with no match, is returned as-is. Pure.
 * @param {string} model
 * @param {string[]} ids
 */
function concreteModelFor(model, ids) {
  const m = String(model || '').trim();
  if (!/^[a-z]+$/.test(m)) return m;
  const prefix = `claude-${m}-`;
  const list = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.startsWith(prefix));
  if (!list.length) return m;
  let best = list[0];
  let bestV = versionOf(best, m);
  for (const id of list.slice(1)) {
    const v = versionOf(id, m);
    let cmp = 0;
    for (let i = 0; i < Math.max(v.length, bestV.length) && cmp === 0; i++) cmp = (v[i] ?? -1) - (bestV[i] ?? -1);
    if (cmp > 0) { best = id; bestV = v; }
  }
  return best;
}

/**
 * The review Task prompt. Pure.
 * @param {{ cwd: string, from: string, to: string, rows: Array<ReturnType<typeof parseRegistryRows>[number]> }} o
 */
function buildReviewPrompt({ cwd, from, to, rows }) {
  const list = rows.map((r) => `- ${r.id} | behavior: ${r.behavior} | model: ${r.model} | observed: ${r.observed} | location: ${r.location} | needle: "${r.needle}"`).join('\n');
  return [
    `The default executor model of the project at ${cwd} changed from ${from} to ${to}. You are running on ${to}.`,
    `Re-test every row of the model-mitigations registry (${REGISTRY_REL.split(path.sep).join('/')}) against this model.`,
    '',
    'HARD RULES',
    `1. ${NO_EDIT_RULE}`,
    '2. Use only read tools (Read, Grep, Glob). Never run a shell command, never write.',
    '3. Your whole answer is ONE table. It is posted as ONE "Needs you" item for the owner; do not split it.',
    '',
    `REGISTRY ROWS (${rows.length})`,
    list,
    '',
    'STEPS',
    '1. For each row, read its location file and confirm the needle is still there.',
    '2. Judge whether you, the model now running, would still show the recorded behavior without the rule',
    '   (reason from the behavior and how the rule is used; be conservative — keep when unsure).',
    '3. Pick one action per row: keep (still needed) or remove (no longer needed — rule and row retire together).',
    '',
    'OUTPUT — exactly this, every row listed, nothing before or after:',
    PROPOSAL_START,
    '| Row | Action (keep/remove) | Why |',
    '|---|---|---|',
    '| MM-... | ... | ... |',
    PROPOSAL_END,
  ].join('\n');
}

function stateFile() {
  return path.join(require('../scheduler/schedulerPaths.cjs').schedulerHome(), STATE_FILE);
}

function defaultDeps() {
  return {
    usageHold: () => require('../../scheduler.cjs').currentUsageHold(),
    isTaskSwitchOn: (/** @type {string} */ cwd) => require('./taskSwitch.cjs').isTaskSwitchOn(cwd),
    readRegistry: (/** @type {string} */ cwd) => {
      try { return fs.readFileSync(path.join(cwd, REGISTRY_REL), 'utf8'); } catch { return null; }
    },
    resolveDefaultExecutorModel: async (/** @type {string} */ cwd) => {
      const { readOverlayAwarePersonaModel, FALLBACK_MODEL } = require('../claude/agentModelResolve.cjs');
      const { readSettingsModel, resolveModelCatalog } = require('../claude/modelCatalog.cjs');
      let model = readOverlayAwarePersonaModel(AGENT, { cwd });
      if (!model || model === 'inherit') model = readSettingsModel(cwd);
      if (!model || model === 'inherit') model = FALLBACK_MODEL;
      const catalog = await resolveModelCatalog({ cwd });
      return concreteModelFor(model, catalog && catalog.models);
    },
    readState: () => require('../util/atomicFs.cjs').readJsonOrSync(stateFile(), {}),
    writeState: (/** @type {any} */ s) => require('../util/atomicFs.cjs').writeJsonAtomicSync(stateFile(), s),
  };
}

function cwdKey(cwd) {
  return crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

/**
 * Decide and, on a model change, start one review Task for `cwd`.
 * Resolves { started: false, reason } or { started: true, from, to, done }
 * where `done` settles after the Task ran and its Needs you item was posted.
 * Never throws.
 * @param {{ cwd: string, now?: number, deps?: Record<string, any> }} o
 */
async function maybeStartMitigationReview({ cwd, now = Date.now(), deps = {} } = /** @type {any} */ ({})) {
  const d = { ...defaultDeps(), ...deps };
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { started: false, reason: 'invalid_cwd' };
  const key = path.resolve(cwd);
  try {
    if (!d.isTaskSwitchOn(key)) return { started: false, reason: 'switch_off' };
    if (inFlight.has(key)) return { started: false, reason: 'in_flight' };
    const registry = d.readRegistry(key);
    if (typeof registry !== 'string') return { started: false, reason: 'no_registry' };
    // Before resolving the model: resolveModelCatalog can run claude -p probes.
    const hold = d.usageHold();
    if (hold) return { started: false, reason: 'usage_held', hold };
    const to = await d.resolveDefaultExecutorModel(key);
    if (typeof to !== 'string' || !to) return { started: false, reason: 'model_unresolved' };

    const state = d.readState() || {};
    const prev = state[key] && typeof state[key].model === 'string' ? state[key].model : null;
    if (prev === to) return { started: false, reason: 'unchanged' };
    if (prev != null && typeof d.adminPost !== 'function') return { started: false, reason: 'no_admin_server' };

    const prevEntry = state[key];
    d.writeState({ ...state, [key]: { model: to, seenAt: new Date(now).toISOString() } });
    if (prev == null) return { started: false, reason: 'first_seen', to };

    const rows = parseRegistryRows(registry);
    if (!rows.length) return { started: false, reason: 'no_rows', from: prev, to };

    const prompt = buildReviewPrompt({ cwd: key, from: prev, to, rows });
    inFlight.add(key);
    const done = runAndPost({ cwd: key, now, prompt, from: prev, to, adminPost: d.adminPost })
      .catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      .then((out) => {
        // A review that never ran (held, or no slot) must not use up this change.
        if (out && NOT_RUN_STATUSES.includes(out.error)) {
          try {
            const cur = d.readState() || {};
            if (cur[key] && cur[key].model === to) {
              const next = { ...cur };
              if (prevEntry === undefined) delete next[key];
              else next[key] = prevEntry;
              d.writeState(next);
            }
          } catch { /* best effort: the next change still reviews */ }
        }
        return out;
      })
      .finally(() => { inFlight.delete(key); });
    return { started: true, reason: 'model_changed', from: prev, to, done };
  } catch (e) {
    return { started: false, reason: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

async function runAndPost({ cwd, now, prompt, from, to, adminPost }) {
  const runId = `${new Date(now).toISOString().slice(0, 10)}-${cwdKey(cwd)}-${to}`;
  const task = await adminPost('/admin/tasks', {
    cwd,
    agent: AGENT,
    missionId: MISSION_ID,
    prompt,
    priority: 'batch',
    timeoutSec: 1800,
    slotWaitSec: 1800,
    caller: { pipeline: PIPELINE, runId, step: 'model_changed' },
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

  const note = `\n…(full table: Task ${b.taskId}, Scheduler → Tasks)`;
  const why = proposal.length > NEEDS_YOU_WHY_MAX
    ? proposal.slice(0, NEEDS_YOU_WHY_MAX - note.length) + note
    : proposal;
  const posted = await adminPost('/admin/needs-you', {
    app: NEEDS_YOU_APP,
    id: `mitigation-review:${runId}`,
    title: `Model changed ${from} → ${to}: model mitigations to remove in ${path.basename(cwd)}`,
    why,
    cwd,
  });
  const ok = !!(posted && posted.status === 200 && posted.body && posted.body.ok);
  return { ok, taskId: b.taskId, needsYou: ok ? posted.body.item : null, error: ok ? undefined : (posted && posted.body && posted.body.error) || 'needs_you_failed' };
}

/**
 * Hourly sweep (first after 10 min) over every project with the switch on.
 * index.cjs calls this once the admin server is up. Returns a stop function.
 * @param {{ adminHttp: any, log?: (msg: string, meta?: any) => void, intervalMs?: number }} o
 */
function startMitigationReviewTimer({ adminHttp, log = () => {}, intervalMs = TICK_MS }) {
  const adminPost = adminPosterFor(adminHttp);
  const tick = async () => {
    let projects = [];
    try { projects = require('./taskSwitch.cjs').listTaskProjects().filter((p) => p.enabled); } catch { projects = []; }
    for (const p of projects) {
      const r = await maybeStartMitigationReview({ cwd: p.cwd, now: Date.now(), deps: { adminPost } });
      if (r.started) {
        log('mitigation review started', { cwd: p.cwd, from: r.from, to: r.to });
        r.done.then((out) => log('mitigation review finished', { cwd: p.cwd, ...out }));
      } else if (r.reason === 'error') {
        log('mitigation review check failed', { cwd: p.cwd, error: r.error });
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
  parseRegistryRows,
  concreteModelFor,
  buildReviewPrompt,
  maybeStartMitigationReview,
  startMitigationReviewTimer,
  PIPELINE,
  REGISTRY_REL,
  READ_ONLY_TOOLS,
  _resetForTests,
};
