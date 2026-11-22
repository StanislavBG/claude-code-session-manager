/**
 * historyLauncher.ts — names WHO launched the sessions in a transcript folder.
 *
 * `~/.claude/projects/<encoded>` folder names encode the session's cwd. Epic
 * chat sessions run in `…/session-manager-epic-worktrees/<hash>/<slug>` and
 * scheduled jobs in `…/session-manager-job-worktrees/<hash>/<slug>`, so the
 * encoded name alone tells the launchers apart. Anything else is `other`.
 *
 * Pure — no store/window imports.
 */
export type HistoryLauncher = 'epic' | 'job' | 'other'

export const HISTORY_LAUNCHERS: readonly HistoryLauncher[] = ['epic', 'job', 'other']

export function launcherOfEncodedDir(encoded: string): HistoryLauncher {
  if (encoded.includes('session-manager-epic-worktrees')) return 'epic'
  if (encoded.includes('session-manager-job-worktrees')) return 'job'
  return 'other'
}
