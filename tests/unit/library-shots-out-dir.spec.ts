import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { outDirFor, LIBRARY_SHOTS, FEEDBACK_SHOTS } from '../web-ui/shotsOutDir.ts'

// The screenshot specs under tests/web-ui/ must never dirty the tree on a normal run
// (project-home-library-shots overwrote four tracked PNGs from 2026-11-22). One convention for both:
// SM_SHOTS_OUT=<path> overrides, SM_UPDATE_SHOTS=1 writes tracked evidence, default = test-results/<specName>/.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
const isIgnored = (rel: string) => {
  try {
    // git check-ignore exits 0 (and prints the path) only when the path is ignored.
    return git('check-ignore', '--no-index', rel).trim() !== ''
  } catch {
    return false
  }
}

const SPECS = [
  { spec: LIBRARY_SHOTS, file: 'tests/web-ui/project-home-library-shots.spec.ts', png: 'knowledge-light.png' },
  { spec: FEEDBACK_SHOTS, file: 'tests/web-ui/project-feedback-shots.spec.ts', png: 'not-linked-light.png' },
]

describe.each(SPECS)('outDirFor($spec.specName)', ({ spec, file, png }) => {
  it('defaults to gitignored test-results/<specName>/ holding no tracked file', () => {
    for (const env of [{}, { SM_UPDATE_SHOTS: '0' }, { SM_UPDATE_SHOTS: '' }, { SM_SHOTS_OUT: '' }]) {
      const out = outDirFor(root, spec, env)
      expect(out).toBe(path.join(root, 'test-results', spec.specName))
      const rel = path.relative(root, out)
      expect(isIgnored(path.join(rel, png))).toBe(true)
      expect(git('ls-files', '--', rel).trim()).toBe('')
    }
  })

  it('writes the tracked (not ignored) evidence folder only when SM_UPDATE_SHOTS=1', () => {
    const out = outDirFor(root, spec, { SM_UPDATE_SHOTS: '1' })
    expect(out).toBe(path.join(root, spec.trackedEvidenceDir))
    expect(spec.trackedEvidenceDir.startsWith('test-results')).toBe(false)
    expect(isIgnored(path.join(spec.trackedEvidenceDir, png))).toBe(false)
  })

  it('SM_SHOTS_OUT=<path> overrides the folder, even with SM_UPDATE_SHOTS=1', () => {
    const abs = path.join(root, 'test-results', 'custom-shots')
    expect(outDirFor(root, spec, { SM_SHOTS_OUT: abs })).toBe(abs)
    expect(outDirFor(root, spec, { SM_SHOTS_OUT: abs, SM_UPDATE_SHOTS: '1' })).toBe(abs)
    expect(outDirFor(root, spec, { SM_SHOTS_OUT: 'rel/shots' })).toBe(path.resolve('rel/shots'))
  })

  it('the spec uses outDirFor with this input and its header states the convention', () => {
    const src = fs.readFileSync(path.join(root, file), 'utf8')
    const varName = spec === LIBRARY_SHOTS ? 'LIBRARY_SHOTS' : 'FEEDBACK_SHOTS'
    expect(src).toMatch(new RegExp(`outDirFor\\(root, ${varName}\\)`))
    expect(src).not.toMatch(/process\.env\.SM_(SHOTS_OUT|UPDATE_SHOTS)/)
    const header = src.slice(0, src.indexOf('outDirFor(root'))
    for (const needle of ['SM_SHOTS_OUT=<path>', 'SM_UPDATE_SHOTS=1', `test-results/${spec.specName}/`]) {
      expect(header).toContain(needle)
    }
  })
})

it('the library evidence folder holds the committed PNGs', () => {
  expect(git('ls-files', '--', LIBRARY_SHOTS.trackedEvidenceDir).trim()).not.toBe('')
})
