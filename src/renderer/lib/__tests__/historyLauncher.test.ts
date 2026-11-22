import { describe, it, expect } from 'vitest'
import { HISTORY_LAUNCHERS, launcherOfEncodedDir } from '../historyLauncher'

describe('launcherOfEncodedDir', () => {
  it('lists the launchers in display order', () => {
    expect(HISTORY_LAUNCHERS).toEqual(['epic', 'job', 'other'])
  })

  it('names an Epic chat session folder epic', () => {
    expect(launcherOfEncodedDir('-home-user--local-state-session-manager-session-manager-epic-worktrees-abc123-my-epic')).toBe('epic')
  })

  it('names a scheduled job folder job', () => {
    expect(launcherOfEncodedDir('-home-user--local-state-session-manager-session-manager-job-worktrees-abc123-3433-slug')).toBe('job')
  })

  it('recognizes both under a temp directory', () => {
    expect(launcherOfEncodedDir('-tmp-session-manager-session-manager-epic-worktrees-h-s')).toBe('epic')
    expect(launcherOfEncodedDir('-tmp-session-manager-session-manager-job-worktrees-h-s')).toBe('job')
  })

  it('names everything else other', () => {
    expect(launcherOfEncodedDir('-home-user-Projects-foo')).toBe('other')
    expect(launcherOfEncodedDir('-tmp-session-manager-abc')).toBe('other')
    expect(launcherOfEncodedDir('')).toBe('other')
  })
})
