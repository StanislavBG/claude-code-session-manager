/**
 * defaultHives — starter hives that ship baked into the renderer.
 *
 * These are NOT writable to disk. They're merged into the hive list at read
 * time so a fresh install has examples; the IPC layer (`hives:list`) only
 * surfaces user-saved hives from `~/.claude/session-manager/hives/`.
 *
 * To customize a default, clone it (button in HiveManagerModal) — that copies
 * the roles/plan into a new user hive with a writable slug.
 */

import type { Recipe } from '../../preload/api'

/** Stable slug prefix used to tag default hives so the renderer can recognize
 *  them and refuse to delete/save them via the manager UI. */
export const DEFAULT_HIVE_SLUG_PREFIX = 'default:'

// TODO(PRD-124): convert inline roles to recipe steps referencing catalog agents
export const DEFAULT_HIVES: Recipe[] = ([
  {
    slug: 'default:code-review',
    name: 'Code review (3 reviewers)',
    description:
      'Three reviewers cover the same diff from different angles: correctness, security, performance.',
    defaultPlan:
      'Review the current diff (HEAD vs main). Each reviewer focuses on their angle, references file:line, and flags severity.',
    roles: [
      {
        label: 'Correctness reviewer',
        prompt:
          'You are the correctness reviewer for this code review hive. Read the current diff (HEAD vs main) and audit it for bugs, edge cases, off-by-one, missing null/undefined handling, race conditions, and incorrect control flow. Report findings as file:line + severity (critical/warning/info) + suggested fix. Do not modify files.',
      },
      {
        label: 'Security reviewer',
        prompt:
          'You are the security reviewer for this code review hive. Read the current diff (HEAD vs main) and audit it for injection (shell/sql/template), auth bypass, secret leakage, path traversal, deserialization issues, missing input validation, and unsafe defaults. Report findings as file:line + severity (critical/warning/info) + suggested fix. Do not modify files.',
      },
      {
        label: 'Performance reviewer',
        prompt:
          'You are the performance reviewer for this code review hive. Read the current diff (HEAD vs main) and audit it for hot-path complexity hazards: nested loops over user-scaled data, O(n^2) on collections, redundant fetches, N+1 queries, missing memoization, blocking I/O on critical paths. Report findings as file:line + severity (critical/warning/info) + suggested fix. Do not modify files.',
      },
    ],
  },
  {
    slug: 'default:build-feature',
    name: 'Build feature (planner + impl + test)',
    description:
      'Planner sketches the task, implementer writes code, tester writes assertions. Run sequentially in three tabs.',
    defaultPlan:
      'Build a new feature end-to-end. Planner writes the design first; implementer and tester wait for the design, then work in parallel.',
    roles: [
      {
        label: 'Planner',
        prompt:
          "You are the planner for this build-feature hive. Sketch the task: list affected files, propose function signatures + tests up front, identify integration points, call out anything ambiguous. Do not write production code yet — the implementer will follow. Output a numbered plan that the implementer and tester can both consume.",
      },
      {
        label: 'Implementer',
        prompt:
          'You are the implementer for this build-feature hive. Wait for the planner to post its design, then write the production code per that plan. Keep changes minimal and focused. Stop at "done" — the tester will validate.',
      },
      {
        label: 'Tester',
        prompt:
          'You are the tester for this build-feature hive. Wait for the planner to post its design, then write tests against the planned API (TDD-style: tests can be drafted before the implementer finishes). Cover happy path + at least 2 edge cases per public function. Use the project\'s existing test framework.',
      },
    ],
  },
  {
    slug: 'default:bug-hunt',
    name: 'Bug hunt (repro + diagnose + fix)',
    description:
      'Reproducer isolates the failing case, diagnoser explains the root cause, fixer patches and verifies.',
    defaultPlan:
      'A bug was reported. Reproduce it deterministically first, then diagnose root cause, then fix and verify the repro now passes.',
    roles: [
      {
        label: 'Reproducer',
        prompt:
          'You are the reproducer for this bug-hunt hive. Read the bug report and isolate a minimal, deterministic reproduction. Write a failing test or a one-shot command that reliably triggers the bug. Output the exact steps + observed vs expected. Do not attempt a fix yet.',
      },
      {
        label: 'Diagnoser',
        prompt:
          "You are the diagnoser for this bug-hunt hive. Wait for the reproducer's minimal repro, then trace through the code to identify the root cause. Output: the failing line(s), why the logic is wrong, and what invariants are violated. Reference file:line. Do not patch — leave that to the fixer.",
      },
      {
        label: 'Fixer',
        prompt:
          "You are the fixer for this bug-hunt hive. Wait for the diagnoser's root-cause analysis, then write the minimal patch and verify the reproducer's repro now passes. Add a regression test if the project has a test suite. Report: changed files + how you confirmed the fix.",
      },
    ],
  },
]) as unknown as Recipe[]

/** True if a slug belongs to a default hive (read-only). */
export function isDefaultHive(slug: string): boolean {
  return slug.startsWith(DEFAULT_HIVE_SLUG_PREFIX)
}
