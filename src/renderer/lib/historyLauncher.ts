/**
 * historyLauncher.ts — names WHO launched the sessions in a transcript folder.
 *
 * `~/.claude/projects/<encoded>` folder names encode the session's cwd. Epic
 * chat sessions run in `…/session-manager-epic-worktrees/<hash>/<slug>` and
 * scheduled jobs in `…/session-manager-job-worktrees/<hash>/<slug>`, so the
 * encoded name alone tells the launchers apart. A Task's spend arrives as a
 * synthetic `sm-task:<absolute cwd>` row (main's task history join), named
 * `task`. Anything else is `other`.
 *
 * Pure — no store/window imports.
 */
export type HistoryLauncher = 'epic' | 'job' | 'task' | 'other'

export const HISTORY_LAUNCHERS: readonly HistoryLauncher[] = ['epic', 'job', 'task', 'other']

/** Key prefix of a Task spend row; the text after it is the project's absolute cwd. */
export const TASK_ROW_PREFIX = 'sm-task:'

export function launcherOfEncodedDir(encoded: string): HistoryLauncher {
  if (encoded.startsWith(TASK_ROW_PREFIX)) return 'task'
  if (encoded.includes('session-manager-epic-worktrees')) return 'epic'
  if (encoded.includes('session-manager-job-worktrees')) return 'job'
  return 'other'
}
