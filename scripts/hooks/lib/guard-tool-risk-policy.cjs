/**
 * guard-tool-risk-policy.cjs — decision logic for
 * scripts/hooks/guard-tool-risk.cjs, split out so it can be `require()`d
 * in-process (by tests) with no CLI-level side effects.
 *
 * `decide(payload, env, deps)` reads the System marks layer from
 * `deps.homeDir || os.homedir()` and the Project layer ONLY from
 * `env.SM_PROJECT_ROOT` (the main checkout) — never `payload.cwd`, which in a
 * job is a disposable worktree the job itself can rewrite. All mark parsing,
 * matching and precedence lives in src/main/lib/claude/toolRiskMarks.cjs;
 * this module only applies the enforcement policy on top of it.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  BLOCKING_MARKS,
  CONFIRM_MARK,
  confirmationRequestsPath,
  argsDigest,
  systemMarksPath,
  projectMarksPath,
  parseRule,
  ruleMatches,
  readMarksLayer,
  resolveMark,
} = require('../../../src/main/lib/claude/toolRiskMarks.cjs');
const { webToolWouldBlock, wouldBlockRecord } = require('../../../src/main/lib/claude/jobSandboxPolicy.cjs');

const TAG = '[guard-tool-risk]';
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_SHOWN = 200;
const LAYER_LABEL = { system: 'System', project: 'Project' };
// Marks the guard refuses unless cleared: the blocking marks plus 'confirm'.
const GUARDED_MARKS = new Set([...BLOCKING_MARKS, CONFIRM_MARK]);

function buildAllow() {
  return { continue: true };
}

function buildDeny(reason) {
  return {
    continue: true,
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function buildAsk(reason) {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  };
}

function isRiskTool(toolName) {
  return toolName === 'Bash' || (typeof toolName === 'string' && toolName.startsWith('mcp__'));
}

function shown(call) {
  if (call.tool === 'Bash') {
    const cmd = call.input && typeof call.input.command === 'string' ? call.input.command : '';
    const one = cmd.replace(/\s+/g, ' ').trim();
    return one.length > MAX_SHOWN ? `${one.slice(0, MAX_SHOWN)}…` : one;
  }
  return call.tool;
}

function parseClearance(env) {
  const raw = env.SM_SCHEDULER_JOB_RISK_TOOLS;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((e) => typeof e === 'string') : [];
  } catch (e) {
    console.error(`${TAG} SM_SCHEDULER_JOB_RISK_TOOLS is not a JSON array, ignoring it: ${e?.message}`);
    return [];
  }
}

/**
 * Does clearance rule `e` cover every command marks rule `r` can match? Used
 * for Bash so that, in a compound command, a clearance for one simple command
 * never clears a different blocking simple command in the same line.
 */
function bashCovers(e, r) {
  if (!e || !r || e.kind !== 'bash' || r.kind !== 'bash') return false;
  if (e.prefix.length > r.prefix.length) return false;
  for (let i = 0; i < e.prefix.length; i++) if (e.prefix[i] !== r.prefix[i]) return false;
  if (!e.exact) return true;
  return r.exact && e.prefix.length === r.prefix.length;
}

function isCleared(entries, call, hit) {
  return entries.some((entry) => {
    if (!ruleMatches(entry, call)) return false;
    if (call.tool !== 'Bash') return true;
    return bashCovers(parseRule(entry), parseRule(hit.rule));
  });
}

/**
 * Resolve the first blocking, uncleared mark for `call`, or null. A cleared
 * rule is re-marked 'read' in a working copy and resolution repeats, so every
 * blocking simple command in a compound Bash line must be cleared on its own.
 */
function findBlocking(call, layers, clearance) {
  const work = {
    system: { ...layers.system, marks: { ...(layers.system.marks || {}) } },
    project: { ...layers.project, marks: { ...(layers.project.marks || {}) } },
  };
  for (let i = 0; i < 64; i++) {
    const hit = resolveMark(call, work);
    if (!hit || !GUARDED_MARKS.has(hit.mark)) return null;
    if (!isCleared(clearance, call, hit)) return hit;
    work[hit.layer].marks[hit.rule] = 'read';
  }
  return null;
}

function blockReason(call, hit, headless) {
  const layer = LAYER_LABEL[hit.layer] || hit.layer;
  return [
    `Blocked: \`${shown(call)}\` is marked '${hit.mark}' by rule \`${hit.rule}\` in the ${layer} tool-risk file ${hit.file || '(unknown file)'}.`,
    headless
      ? `A headless job may run a '${hit.mark}' tool only when its PRD clears it: name it in riskTools (e.g. "${hit.rule}") in the PRD and re-queue.`
      : `This project enforces tool-risk marks in interactive sessions (interactive: true); to run it from a job, name it in riskTools in the PRD.`,
    'Do not work around this refusal (no other tool, wrapper, script or alias for the same effect); stop and report that this step needs clearance.',
  ].join(' ');
}

function confirmReason(call, hit, digest, recorded) {
  const layer = LAYER_LABEL[hit.layer] || hit.layer;
  return [
    `Blocked, pending confirmation: \`${shown(call)}\` is marked 'confirm' by rule \`${hit.rule}\` in the ${layer} tool-risk file ${hit.file || '(unknown file)'}.`,
    recorded
      ? `A confirmation request (args digest ${digest}) was sent to the owner's Needs you list; if the owner approves, this same session is resumed and this exact call (same arguments) may run once.`
      : `No confirmation request could be sent from this run (args digest ${digest}); a headless job may run it only when its PRD names "${hit.rule}" in riskTools.`,
    'Do not retry it and do not work around this refusal (no other tool, wrapper, script or alias for the same effect); finish the rest of the work and report that this step is pending confirmation.',
  ].join(' ');
}

/**
 * Append one confirmation request for the main process to post (Needs you +
 * the Epic's job.confirmation_requested event). Only a scheduler job records
 * one: it names the job and Epic the answer belongs to. Never throws.
 * @returns {boolean} whether the record was written
 */
function recordConfirmationRequest(call, hit, digest, env, deps, payload = {}) {
  const jobSlug = env.SM_SCHEDULER_JOB_SLUG || null;
  if (!jobSlug) return false;
  // The pending record names the session to resume once the owner approves.
  const sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null;
  try {
    (deps.toolClearance || require('../../../src/main/lib/scheduler/toolClearance.cjs')).recordPendingConfirmation({
      tool: call.tool,
      argsDigest: digest,
      jobSlug,
      sessionId,
      epicId: env.SM_SCHEDULER_JOB_EPIC_ID || null,
      cwd: env.SM_PROJECT_ROOT || null,
      rule: hit.rule,
      summary: shown(call),
    });
  } catch (e) {
    console.error(`${TAG} pending confirmation not recorded: ${e?.message}`);
  }
  try {
    const file = deps.confirmationRequestsFile
      || confirmationRequestsPath(require('../../../src/main/lib/scheduler/schedulerPaths.cjs').schedulerHome());
    const record = {
      time: new Date().toISOString(),
      tool: call.tool,
      argsDigest: digest,
      jobSlug,
      epicId: env.SM_SCHEDULER_JOB_EPIC_ID || null,
      cwd: env.SM_PROJECT_ROOT || null,
      rule: hit.rule,
      layer: hit.layer,
      summary: shown(call),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
    return true;
  } catch (e) {
    console.error(`${TAG} confirmation request not recorded: ${e?.message}`);
    return false;
  }
}

/**
 * Consume a live single-use clearance for this job's exact call. Only a
 * scheduler job (named by SM_SCHEDULER_JOB_SLUG) can hold one. Never throws.
 * @returns {boolean} whether a clearance was consumed
 */
function consumeConfirmClearance(call, digest, env, deps) {
  const jobSlug = env.SM_SCHEDULER_JOB_SLUG || null;
  if (!jobSlug) return false;
  try {
    const lib = deps.toolClearance || require('../../../src/main/lib/scheduler/toolClearance.cjs');
    const r = lib.consumeClearance({ cwd: env.SM_PROJECT_ROOT || null, jobSlug, tool: call.tool, argsDigest: digest });
    if (!r.ok && r.reason !== 'none') console.error(`${TAG} clearance for ${call.tool} refused: ${r.reason}`);
    return r.ok === true;
  } catch (e) {
    console.error(`${TAG} clearance check failed, refusing: ${e?.message}`);
    return false;
  }
}

function unreadableReason(layerObj, which) {
  return [
    `Blocked: the ${which} tool-risk file ${layerObj.file} cannot be used (${layerObj.error}), so every Bash and MCP call is refused (fail closed).`,
    'A human must fix the file in Settings.',
    'Do not work around this refusal; stop and report it.',
  ].join(' ');
}

function protectedTarget(payload, homeDir, projectRoot) {
  const input = payload.tool_input || {};
  const target = typeof input.file_path === 'string' ? input.file_path
    : typeof input.notebook_path === 'string' ? input.notebook_path : null;
  if (!target) return null;
  const base = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const resolved = path.resolve(base, target);
  const guarded = [systemMarksPath(homeDir)];
  if (projectRoot) guarded.push(projectMarksPath(projectRoot));
  if (typeof payload.cwd === 'string' && payload.cwd) guarded.push(projectMarksPath(payload.cwd));
  return guarded.some((g) => path.resolve(g) === resolved) ? resolved : null;
}

function parseJobEnvironment(env) {
  const raw = env.SM_JOB_ENVIRONMENT;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (e) {
    console.error(`${TAG} SM_JOB_ENVIRONMENT is not a JSON object, ignoring it: ${e?.message}`);
    return null;
  }
}

/**
 * Environment check for a headless job's WebFetch/WebSearch call that its
 * environment (env SM_JOB_ENVIRONMENT, set by the scheduler) disallows — tool
 * not allowed, or host off the allow-list. Appends one
 * 'environment_would_block' audit record and returns the deny reason when the
 * mode (SM_JOB_ENVIRONMENT_MODE) is 'enforce' — the default; returns null in
 * 'report' mode, when nothing applies, or on an internal error.
 * @returns {string|null}
 */
function environmentWebToolDenial(payload, env, deps) {
  try {
    const toolName = payload.tool_name;
    if (toolName !== 'WebFetch' && toolName !== 'WebSearch') return null;
    const jobEnv = parseJobEnvironment(env);
    const hit = webToolWouldBlock(jobEnv, toolName, payload.tool_input);
    if (!hit) return null;
    const mode = env.SM_JOB_ENVIRONMENT_MODE === 'report' ? 'report' : 'enforce';
    const envId = jobEnv && typeof jobEnv.id === 'string' ? jobEnv.id : '(unnamed)';
    try {
      const append = deps.appendAuditEvent || require('../../../src/main/lib/telemetry/auditLog.cjs').appendAuditEvent;
      append('environment_would_block', wouldBlockRecord({
        slug: env.SM_SCHEDULER_JOB_SLUG || null,
        persona: env.SM_JOB_PERSONA || null,
        environment: envId,
        what: hit.what,
        detail: hit.detail,
        mode,
      }));
    } catch (e) {
      console.error(`${TAG} environment audit failed: ${e?.message}`);
    }
    if (mode !== 'enforce') return null;
    const why = hit.what === 'host_off_allowlist'
      ? `host ${hit.detail} is outside environment '${envId}'s network allow-list`
      : `environment '${envId}' does not allow ${toolName}`;
    return [
      `Blocked: ${toolName} — ${why}.`,
      `A persona that needs the open web declares \`environment: open-web\` in its frontmatter.`,
      'Do not work around this refusal (no curl, wget or other tool for the same fetch); stop and report that this step needs the open web.',
    ].join(' ');
  } catch (e) {
    console.error(`${TAG} environment check failed: ${e?.message}`);
    return null;
  }
}

/**
 * PreToolUse payload in, hook-response object out. No stdin/stdout and no
 * process.exit. `env` defaults to process.env; `deps.homeDir` to os.homedir().
 */
function decide(payload, env = process.env, deps = {}) {
  try {
    const homeDir = deps.homeDir || os.homedir();
    const projectRoot = env.SM_PROJECT_ROOT || null;
    const headless = Boolean(env.SM_SCHEDULER_JOB_SLUG) || env.SM_TOOL_RISK_HEADLESS === '1';
    const toolName = payload.tool_name;
    if (headless) {
      const envDenial = environmentWebToolDenial(payload, env, deps);
      if (envDenial) return buildDeny(envDenial);
    }

    const system = readMarksLayer(systemMarksPath(homeDir));
    const project = projectRoot
      ? readMarksLayer(projectMarksPath(projectRoot))
      : { ok: true, exists: false, marks: {}, interactive: false, file: null };

    let refuse;
    if (headless) {
      refuse = buildDeny;
    } else if (project.ok && project.interactive) {
      // A -p Chat turn has no approval surface: the CLI auto-denies 'ask' with generic text.
      refuse = env.SM_CHAT_SESSION_ID ? buildDeny : buildAsk;
    } else {
      return buildAllow(); // interactive session without opt-in — inert
    }

    if (WRITE_TOOLS.has(toolName)) {
      const target = protectedTarget(payload, homeDir, projectRoot);
      if (target) {
        return buildDeny(`Blocked: ${toolName} of ${target} — marks are human-owned: edit them in Settings. Do not work around this refusal.`);
      }
      return buildAllow();
    }

    if (!isRiskTool(toolName)) return buildAllow();

    if (system.exists && !system.ok) return refuse(unreadableReason(system, 'System'));
    if (project.exists && !project.ok) return refuse(unreadableReason(project, 'Project'));

    const call = { tool: toolName, input: payload.tool_input };
    const clearance = headless ? parseClearance(env) : [];
    const hit = findBlocking(call, { system, project }, clearance);
    if (!hit) return buildAllow();
    if (hit.mark === CONFIRM_MARK) {
      // Interactive Terminal: the CLI's own approval prompt IS the confirmation.
      if (!headless) return refuse(`Confirm: \`${shown(call)}\` is marked 'confirm' by rule \`${hit.rule}\`.`);
      const digest = argsDigest(payload.tool_input);
      // An owner-approved clearance for this exact call (same job, tool and
      // args digest) lets ONE call through; it is consumed atomically here.
      if (consumeConfirmClearance(call, digest, env, deps)) return buildAllow();
      const recorded = recordConfirmationRequest(call, hit, digest, env, deps, payload);
      return buildDeny(confirmReason(call, hit, digest, recorded));
    }
    return refuse(blockReason(call, hit, headless));
  } catch (e) {
    console.error(`${TAG} internal error, failing open: ${e?.message}`);
    return buildAllow();
  }
}

/** Mirrors the CLI's stdin-JSON handling so it can be exercised without a spawn. */
function parsePayload(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`${TAG} malformed stdin JSON, failing open: ${e?.message}`);
    return {};
  }
}

module.exports = { decide, parsePayload };
