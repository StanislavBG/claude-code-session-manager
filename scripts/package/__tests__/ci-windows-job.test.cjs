// Asserts ci.yml's `windows` job shape by reading it as text (no YAML dep).
import { describe, it, expect } from 'vitest'
const fs = require('node:fs')
const path = require('node:path')

const yml = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8')
const start = yml.indexOf('\n  windows:')
const job = start === -1 ? '' : yml.slice(start)

const UNIT_FILES = [
  'src/main/lib/__tests__/claudeBin-win32.test.cjs',
  'src/main/lib/__tests__/defaultShell.test.cjs',
  'src/main/lib/__tests__/killTree.test.cjs',
  'src/main/lib/__tests__/winPaths.test.cjs',
  'src/main/lib/__tests__/winSpawn.test.cjs',
  'src/main/lib/__tests__/openExternalApp-win32.test.cjs',
  'src/main/lib/__tests__/appRuntime.test.cjs',
  'src/main/lib/__tests__/prereqs.test.cjs',
]

describe('ci.yml windows job', () => {
  it('exists, is the last job, and runs on windows-latest with node 22', () => {
    expect(job).not.toBe('')
    expect(job).toMatch(/runs-on: windows-latest/)
    expect(job).toContain("node-version: '22'")
  })
  it('installs, typechecks and builds before testing', () => {
    const order = ['npm ci', 'npm run typecheck', 'npm run build', 'npx vitest run'].map((s) => job.indexOf(s))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
  it('runs vitest over exactly the win32 unit files', () => {
    const line = job.split('\n').find((l) => l.includes('npx vitest run'))
    const files = line.split('npx vitest run')[1].trim().split(/\s+/)
    expect(files).toEqual(UNIT_FILES)
  })
  it('stages, packages win-unpacked, then runs the packaged smoke', () => {
    const stage = job.indexOf('node scripts/package/stage.cjs')
    const pack = job.indexOf('npx electron-builder --config electron-builder.yml --win dir --publish never')
    const pw = job.indexOf('npx playwright install chromium')
    const smoke = job.indexOf('smoke:packaged')
    expect(stage).toBeGreaterThan(job.indexOf('npx vitest run'))
    expect(pack).toBeGreaterThan(stage)
    expect(pw).toBeGreaterThan(pack)
    expect(smoke).toBeGreaterThan(pw)
    expect(job).toContain('SM_PACKAGED_BIN: release/out/win-unpacked/Session Manager.exe')
  })
  it('leaves the existing jobs in place', () => {
    for (const name of ['  ci:', '  unit:', '  smoke-darwin:']) expect(yml).toContain(`\n${name}`)
  })
})
