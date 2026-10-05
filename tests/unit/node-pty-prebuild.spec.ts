import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '..', '..')
const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'))
const prebuildDir = path.join(
  repoRoot, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`,
)

// node-pty 1.2 is N-API: its shipped prebuild must load under the bundled Electron
// with no electron-rebuild step.
describe('node-pty prebuild', () => {
  it.skipIf(!fs.existsSync(prebuildDir))('loads under the bundled Electron', () => {
    const electronBin = requireFromRepo('electron') as string
    const script = `const m = require(${JSON.stringify(path.join(prebuildDir, 'pty.node'))}); process.stdout.write(typeof m.fork)`
    const r = spawnSync(electronBin, ['-e', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('function')
  }, 70_000)
})
