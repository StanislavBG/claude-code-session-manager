/**
 * defaultHives — starter recipes that ship baked into the renderer.
 *
 * These are NOT writable to disk. They're merged into the recipe list at read
 * time so a fresh install has examples; the IPC layer (`hives:list`) only
 * surfaces user-saved recipes from `~/.claude/session-manager/hives/`.
 *
 * To customize a default, clone it (button in HiveManagerModal) — that copies
 * the steps into a new user recipe with a writable slug.
 */

import type { Recipe } from '../../preload/api'

/** Stable slug prefix used to tag default recipes so the renderer can recognize
 *  them and refuse to delete/save them via the manager UI. */
export const DEFAULT_HIVE_SLUG_PREFIX = 'default:'

export const DEFAULT_HIVES: Recipe[] = [
  {
    slug: 'default:code-review',
    name: 'Code review (3 reviewers)',
    description:
      'Three reviewers cover the same diff from different angles: correctness, security, performance.',
    brief:
      'Review the current diff (HEAD vs main). Each reviewer focuses on their angle, references file:line, and flags severity.',
    steps: [
      { agentName: 'code-reviewer' },
      { agentName: 'security-auditor' },
      { agentName: 'perf-profiler' },
    ],
  },
  {
    slug: 'default:build-feature',
    name: 'Build feature (design + review + test)',
    description:
      'API designer sketches the interface, code reviewer validates the plan, test runner verifies the result.',
    brief:
      'Build a new feature end-to-end. Designer proposes the API first; reviewer and tester follow.',
    steps: [
      { agentName: 'api-designer' },
      { agentName: 'code-reviewer' },
      { agentName: 'test-runner' },
    ],
  },
  {
    slug: 'default:bug-hunt',
    name: 'Bug hunt (diagnose + verify)',
    description:
      'Debugger diagnoses root cause from the stack trace, test runner confirms the fix passes.',
    brief:
      'A bug was reported. Diagnose the root cause first, then verify the fix with the test suite.',
    steps: [
      { agentName: 'debugger' },
      { agentName: 'test-runner' },
    ],
  },
]

/** True if a slug belongs to a default recipe (read-only). */
export function isDefaultHive(slug: string): boolean {
  return slug.startsWith(DEFAULT_HIVE_SLUG_PREFIX)
}
