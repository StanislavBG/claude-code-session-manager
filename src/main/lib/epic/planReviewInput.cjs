'use strict';

/**
 * planReviewInput.cjs — pure builder for the scheduler_create_prd input of one
 * plan-review job (agentType plan-reviewer), plus a deterministic structural
 * pre-check whose findings go into the job's notes. Pure: no fs, no child_process.
 */

const { bareSlug } = require('../prd/depSlugResolve.cjs');

const PERSONA_LINE = 'Work as the plan-reviewer persona — the procedure is your system prompt.';

/** @param {any} m */
function isDocMember(m) {
  const goal = typeof m.goal === 'string' ? m.goal.trim().toLowerCase() : '';
  if (goal.startsWith('doc')) return true;
  const files = Array.isArray(m.files) ? m.files : [];
  return files.length > 0 && files.every((f) => typeof f === 'string' && /\.md$/i.test(f));
}

/**
 * @param {Array<any>} members
 * @returns {Array<{ check: string, slug: string, detail: string }>}
 */
function structuralFindings(members) {
  const list = Array.isArray(members) ? members : [];
  const bySlug = new Map(list.map((m) => [bareSlug(m.slug), m]));
  const findings = [];

  /** @param {any} start */
  const reachesNonDoc = (start) => {
    const seen = new Set();
    const stack = [...(start.dependsOn || [])];
    while (stack.length) {
      const b = bareSlug(stack.pop());
      if (seen.has(b)) continue;
      seen.add(b);
      const m = bySlug.get(b);
      if (!m) continue;
      if (!isDocMember(m)) return true;
      stack.push(...(m.dependsOn || []));
    }
    return false;
  };

  for (const m of list) {
    if (isDocMember(m) && !reachesNonDoc(m)) {
      findings.push({
        check: 'doc-after-code',
        slug: m.slug,
        detail: `doc PRD ${m.slug} does not depend (transitively) on any code PRD in the plan`,
      });
    }
    for (const d of m.dependsOn || []) {
      if (!bySlug.has(bareSlug(d))) {
        findings.push({
          check: 'depends-on',
          slug: m.slug,
          detail: `${m.slug} dependsOn ${d}, which is not in the plan`,
        });
      }
    }
  }
  return findings;
}

/**
 * @param {{ epicId: string, cwd: string, epicGoal?: string, validateSlug: string,
 *           members: Array<any>, baseSha?: string | null, round?: number }} args
 */
function buildPlanReviewInput({ epicId, cwd, epicGoal, validateSlug, members, baseSha, round }) {
  const list = Array.isArray(members) ? members : [];
  const bare = bareSlug(validateSlug);
  const slug = `plan-review-${bare}${round && round >= 2 ? `-r${round}` : ''}`;
  const recordPath = `session-manager-operations/plan-records/${epicId}/${validateSlug}.plan-review.md`;

  const acceptanceCriteria = list.map((m) => `Review ${m.slug}`);
  acceptanceCriteria.push(`Record written at ${recordPath}, relative to the job worktree's repository root (git rev-parse --show-toplevel), never relative to a subdirectory you cd'd into. Do not git add or commit it — the scheduler copies it to the main checkout`);

  const lines = [
    PERSONA_LINE,
    `Epic goal: ${epicGoal || 'unknown'}`,
    baseSha ? `Base: ${baseSha}` : 'Base: unknown',
    '',
    'Plan members:',
  ];
  for (const m of list) {
    lines.push(
      `- ${m.slug}${m.title ? ` — ${m.title}` : ''}`,
      `  PRD file: ${m.prdPath}`,
      `  Goal: ${m.goal || ''}`,
      '  Acceptance criteria:',
      ...(m.acceptanceCriteria || []).map((c) => `    - ${c}`),
      `  Files: ${(m.files || []).join(', ') || '(none)'}`,
      `  Gate: ${(m.gate || []).join(' ; ') || '(none)'}`,
      `  dependsOn: ${(m.dependsOn || []).join(', ') || '(none)'}`,
    );
  }
  const findings = structuralFindings(list);
  lines.push('', 'Structural pre-check:');
  if (findings.length === 0) lines.push('- no findings');
  for (const f of findings) lines.push(`- [${f.check}] ${f.detail}`);
  lines.push('', 'Created automatically by the scheduler; no human or planner wrote this PRD.');

  return {
    title: `Plan review: ${bare}${round && round >= 2 ? ` (round ${round})` : ''}`,
    slug,
    goal: `review. Independent review of this Epic's plan before its PRDs dispatch: ${list.map((m) => m.slug).join(', ')}.`,
    acceptanceCriteria,
    implementationNotes: lines.join('\n'),
    outOfScope: ['Editing product code', 'Queuing fix PRDs'],
    gate: ['none'],
    files: [recordPath],
    deliverable: 'artifact',
    artifactPaths: [recordPath],
    agentType: 'plan-reviewer',
    tag: 'build',
    sourcePromptId: epicId,
    cwd,
  };
}

module.exports = { buildPlanReviewInput, structuralFindings };
