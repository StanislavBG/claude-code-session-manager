'use strict';

/**
 * epicSweepValidator.cjs — pure builder for the scheduler_create_prd input of a
 * "sweep" validator PRD: one headless validator job (agentType validator) that
 * checks the completed PRDs of a settled Epic that no validator has checked.
 * Pure: no fs, no child_process. The caller decides when a sweep is needed and
 * whether to create the PRD.
 */

const { bareSlug } = require('../prd/depSlugResolve.cjs');

const SWEEP_SLUG_PREFIX = 'validate-sweep';
const MAX_SWEEP_PRDS = 25;

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
function buildSweepValidatorInput({ epicId, cwd, uncovered, baseSha, now }) {
  if (!Array.isArray(uncovered) || uncovered.length === 0) return { input: null, carried: [] };

  const covered = uncovered.slice(0, MAX_SWEEP_PRDS);
  const carried = uncovered.slice(MAX_SWEEP_PRDS);
  const names = covered.map((entry) => entry.bareSlug || bareSlug(entry.slug));

  const stamp = new Date(now).toISOString().replace(/\D/g, '').slice(0, 12);
  const slug = `${SWEEP_SLUG_PREFIX}-${stamp}`;
  const recordPath = `session-manager-operations/reviews/validation/${epicId}/${slug}.md`;

  const acceptanceCriteria = names.map(
    (name) => `${name} verified against its PRD file (find it by slug under $SM_PROJECT_ROOT/session-manager-operations/scheduler/epics/${epicId}/prds/ or prds-archived/, possibly in a timestamped subfolder)`,
  );
  acceptanceCriteria.push(`Record written and committed at ${recordPath}`);

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
    estimateMinutes: 10,
    agentType: 'validator',
    tag: 'build',
    sourcePromptId: epicId,
    cwd,
    dependsOn: names,
  };

  return { input, carried };
}

module.exports = { SWEEP_SLUG_PREFIX, MAX_SWEEP_PRDS, isSweepValidatorSlug, buildSweepValidatorInput };
