/**
 * Child-process PATH must include Apple Silicon Homebrew.
 *
 * Electron launched from Finder/Dock has a stripped PATH that lacks
 * /opt/homebrew/bin. Spawned ptys, `claude -p` jobs, plugin installs, and the
 * credential CLI fallback all build their PATH from userBinDirs() — if that
 * list drops Homebrew (as two call sites previously did), `claude`/node/git
 * ENOENT and "nothing works" on a Mac. Lock the dirs in.
 *
 * Source: src/main/lib/cleanEnv.cjs.
 */
import { describe, it, expect } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { userBinDirs, pathWithUserBins } = require('../../src/main/lib/cleanEnv.cjs')

describe('userBinDirs', () => {
  it('includes Apple Silicon Homebrew bin + sbin', () => {
    const dirs = userBinDirs()
    expect(dirs).toContain('/opt/homebrew/bin')
    expect(dirs).toContain('/opt/homebrew/sbin')
  })

  it('includes the standard system + user bins', () => {
    const dirs = userBinDirs()
    expect(dirs).toContain('/usr/local/bin')
    expect(dirs).toContain('/usr/bin')
    expect(dirs.some((d: string) => d.endsWith('/.npm-global/bin'))).toBe(true)
  })

  it('pathWithUserBins prepends the dirs ahead of the inherited PATH', () => {
    const p = pathWithUserBins()
    expect(p.startsWith(userBinDirs().join(':'))).toBe(true)
    expect(p).toContain('/opt/homebrew/bin')
  })
})
