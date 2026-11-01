'use strict';

/**
 * epicSweepValidator.cjs — pure builder for the scheduler_create_prd input of a
 * "sweep" validator PRD: one headless validator job (agentType validator) that
 * checks the completed PRDs of a settled Epic that no validator has checked.
 * Pure: no fs, no child_process. The caller decides when a sweep is needed and
 * whether to create the PRD.
 *
 * Sizing: the sweep's kill budget must cover every gate running to its own
 * timeout plus reading/writing time, because a kill loses every minute of
 * evidence. Why these numbers: across 916 real validator runs the most
 * non-gate time was 13.7 minutes, hence VALIDATOR_OVERHEAD_MS = 15 minutes;
 * UNKNOWN_GATE_MS matches definitionOfDone's DEFAULT_GATE_TIMEOUT_MS; the plain
 * sum with no dedupe follows the validator's rule to re-run every command in
 * each PRD's gate. Real runs sit far under their timeouts (median 7%), so about
 * 2.3% of sweeps (3 of 130) will split that strictly did not need it. An extra
 * validator costs far less than a lost run, so that is accepted.
 */

const { bareSlug } = require('../prd/depSlugResolve.cjs');
const { JOB_BUDGET_FACTOR, JOB_BUDGET_CEILING_MS } = require('../scheduler/schedulerConfig.cjs');

const SWEEP_SLUG_PREFIX = 'validate-sweep';
const MAX_SWEEP_PRDS = 25;
const VALIDATOR_OVERHEAD_MS = 15 * 60_000;
const UNKNOWN_GATE_MS = 5 * 60_000;
const MIN_VALIDATOR_ESTIMATE_MINUTES = 10;

/** A value that is not a finite number >= 0 counts UNKNOWN_GATE_MS; 0 stays 0. */
function gateMsOrUnknown(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : UNKNOWN_GATE_MS;
}

/** max(10, ceil((sum + overhead) / 60000 / factor)). */
function validatorEstimateMinutes(gateMsValues, { factor } = {}) {
  const f = typeof factor === 'number' && factor > 0 ? factor : JOB_BUDGET_FACTOR;
  const sum = (Array.isArray(gateMsValues) ? gateMsValues : []).reduce((a, v) => a + gateMsOrUnknown(v), 0);
  return Math.max(MIN_VALIDATOR_ESTIMATE_MINUTES, Math.ceil((sum + VALIDATOR_OVERHEAD_MS) / 60_000 / f));
}

const PERSONA_LINE = 'Work as the validator persona — the procedure is your system prompt.';

/** True for `validate-sweep-…`, with or without a leading `NN-` prefix. */
function isSweepValidatorSlug(slug) {
  if (typeof slug !== 'string') return false;
  return slug.replace(/^\d+-/, '').startsWith(`${SWEEP_SLUG_PREFIX}-`);
}

/**
 * @param {{ epicId: string, cwd: string,
 *           uncovered: Array<{ slug: string, bareSlug?: string, landedCommit?: string }>,
 *           baseSha?: string | null, now: number | Date | string }} args
 * @returns {{ input: object | null, carried: Array<object> }}
 */
function buildSweepValidatorInput({ epicId, cwd, uncovered, baseSha, now, jobBudget }) {
  if (!Array.isArray(uncovered) || uncovered.length === 0) return { input: null, carried: [] };

  const factor = jobBudget && typeof jobBudget.factor === 'number' && jobBudget.factor > 0
    ? jobBudget.factor : JOB_BUDGET_FACTOR;
  const ceilingMs = jobBudget && typeof jobBudget.ceilingMs === 'number' && jobBudget.ceilingMs > 0
    ? jobBudget.ceilingMs : JOB_BUDGET_CEILING_MS;

  // First-fit in input order; the first entry always joins.
  const covered = [];
  const carried = [];
  let workMs = VALIDATOR_OVERHEAD_MS;
  for (const entry of uncovered) {
    const g = gateMsOrUnknown(entry && entry.gateMs);
    if (covered.length === 0 || (covered.length < MAX_SWEEP_PRDS && workMs + g <= ceilingMs)) {
      covered.push(entry);
      workMs += g;
    } else {
      carried.push(entry);
    }
  }
  const budgetExempt = covered.length === 1 && workMs > ceilingMs;
  const names = covered.map((entry) => entry.bareSlug || bareSlug(entry.slug));

  const stamp = new Date(now).toISOString().replace(/\D/g, '').slice(0, 14);
  const slug = `${SWEEP_SLUG_PREFIX}-${stamp}`;
  const recordPath = `session-manager-operations/reviews/validation/${epicId}/${slug}.md`;

  const acceptanceCriteria = names.map(
    (name) => `${name} verified against its PRD file (find it by slug under $SM_PROJECT_ROOT/session-manager-operations/scheduler/epics/${epicId}/prds/ or prds-archived/, possibly in a timestamped subfolder)`,
  );
  acceptanceCriteria.push(`Record written and committed at ${recordPath}, relative to the repository root (git rev-parse --show-toplevel), never relative to a subdirectory you cd'd into`);

  const base = baseSha
    ? `Base: ${baseSha}`
    : 'Base: unknown — review each PRD\'s own landed commit (git log --all --grep=<slug>)';

  const input = {
    title: `Validate: unchecked work in this session (${covered.length} PRDs)`,
    slug,
    goal: `validate. Sweep validator queued by the scheduler when this Epic settled with completed PRDs no validator had checked: ${names.join(', ')}.`,
    acceptanceCriteria,
    implementationNotes: [
      PERSONA_LINE,
      base,
      'Created automatically by the scheduler; no human or planner wrote this PRD.',
    ].join('\n'),
    outOfScope: ['Editing product code', 'Queuing fix PRDs'],
    gate: ['none'],
    files: [recordPath],
    estimateMinutes: validatorEstimateMinutes(covered.map((e) => e.gateMs), { factor }),
    agentType: 'validator',
    tag: 'build',
    sourcePromptId: epicId,
    cwd,
    dependsOn: names,
  };

  if (budgetExempt) input.budgetExempt = true;

  return { input, carried };
}

module.exports = {
  SWEEP_SLUG_PREFIX,
  MAX_SWEEP_PRDS,
  VALIDATOR_OVERHEAD_MS,
  UNKNOWN_GATE_MS,
  MIN_VALIDATOR_ESTIMATE_MINUTES,
  isSweepValidatorSlug,
  validatorEstimateMinutes,
  buildSweepValidatorInput,
};
