import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'

const requireCjs = createRequire(import.meta.url)
const repoRoot = path.resolve(__dirname, '../..')
const pkg = requireCjs('../../package.json') as {
  dependencies: Record<string, string>
  files?: string[]
  scripts: Record<string, string | undefined>
}

const SCAN_DIRS = ['src/main', 'src/preload', 'scripts', 'bin']

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(cjs|js)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** The published package's "Dependencies" count stays at 4. */
describe('runtime dependency allowlist', () => {
  it('ships exactly chokidar, electron, node-pty, ws, zod', () => {
    expect(
      Object.keys(pkg.dependencies).sort(),
      'Adding a runtime dependency is a deliberate decision: it ships to every user. ' +
        'Dev deps are bundled by Vite and do not ship — put it in devDependencies unless shipped main/preload/bin code requires it at runtime.',
    ).toEqual(['chokidar', 'electron', 'node-pty', 'ws', 'zod'])
  })

  it('no shipped code requires a removed package', () => {
    const banned = /require\(\s*['"](@opentelemetry\/|@modelcontextprotocol\/|@electron\/rebuild)/
    const offenders: string[] = []
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(repoRoot, dir))) {
        if (banned.test(fs.readFileSync(file, 'utf8'))) offenders.push(path.relative(repoRoot, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('has no postinstall script or file entry', () => {
    expect(pkg.scripts.postinstall).toBeUndefined()
    expect((pkg.files ?? []).filter((f) => f.includes('scripts/postinstall.cjs'))).toEqual([])
  })
})
