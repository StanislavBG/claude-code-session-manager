import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { libraryShotsOutDir, LIBRARY_SHOTS_EVIDENCE_REL } from '../web-ui/shotsOutDir.ts'

// tests/web-ui/project-home-library-shots.spec.ts must never dirty the tree on a normal run
// (it overwrote four tracked PNGs from 2026-11-22). Only SM_UPDATE_SHOTS=1 may write the evidence folder.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })

describe('libraryShotsOutDir', () => {
  it('defaults to a gitignored folder holding no tracked file', () => {
    for (const env of [{}, { SM_UPDATE_SHOTS: '0' }, { SM_UPDATE_SHOTS: '' }]) {
      const out = libraryShotsOutDir(root, env)
      const rel = path.relative(root, out)
      expect(rel.startsWith('..') || path.isAbsolute(rel)).toBe(false)
      expect(rel).not.toContain('session-manager-operations')
      // git check-ignore exits 0 only when the path is ignored.
      expect(git('check-ignore', '--no-index', path.join(rel, 'knowledge-light.png')).trim()).not.toBe('')
      // No tracked file lives under that folder.
      expect(git('ls-files', '--', rel).trim()).toBe('')
    }
  })

  it('writes the tracked evidence folder only when SM_UPDATE_SHOTS=1', () => {
    const out = libraryShotsOutDir(root, { SM_UPDATE_SHOTS: '1' })
    expect(out).toBe(path.join(root, LIBRARY_SHOTS_EVIDENCE_REL))
    expect(git('ls-files', '--', LIBRARY_SHOTS_EVIDENCE_REL).trim()).not.toBe('')
  })
})
