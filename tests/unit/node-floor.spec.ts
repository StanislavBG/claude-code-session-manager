import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

const requireCjs = createRequire(import.meta.url)
const { parseFloor, isBelow, nodeFloor } = requireCjs('../../bin/node-floor.cjs') as {
  parseFloor: (range: unknown) => [number, number, number] | null
  isBelow: (version: string, floor: [number, number, number]) => boolean
  nodeFloor: () => [number, number, number] | null
}

const repoRoot = path.resolve(__dirname, '../..')
const pkg = requireCjs('../../package.json') as { engines: { node: string } }

/**
 * The Node floor the npx launcher needs. It once said `>=18` for 30+ releases while Electron
 * 42's own installer demanded 22.12 — every Node 18 user got a "network issue" error. These
 * tests pin the floor to what the shipped runtime deps actually declare, and pin every public
 * statement of it to package.json.
 */
describe('bin/node-floor.cjs', () => {
  it('parses >= ranges, with or without spaces, v prefix or missing parts', () => {
    expect(parseFloor('>=22.12.0')).toEqual([22, 12, 0])
    expect(parseFloor('>= 22.12.0')).toEqual([22, 12, 0])
    expect(parseFloor('>=v20')).toEqual([20, 0, 0])
    expect(parseFloor('>=18.3')).toEqual([18, 3, 0])
  })

  it('refuses ranges it cannot honestly reduce to one floor', () => {
    expect(parseFloor('^22.12.0')).toBeNull()
    expect(parseFloor('>=20 <23')).toBeNull()
    expect(parseFloor('^20.19.0 || >=22.12.0')).toBeNull()
    expect(parseFloor(undefined)).toBeNull()
    expect(parseFloor('')).toBeNull()
  })

  it('compares process.versions.node against the floor', () => {
    const floor: [number, number, number] = [22, 12, 0]
    expect(isBelow('18.20.4', floor)).toBe(true)
    expect(isBelow('20.19.5', floor)).toBe(true)
    expect(isBelow('22.11.9', floor)).toBe(true)
    expect(isBelow('22.12.0', floor)).toBe(false)
    expect(isBelow('v22.12.1', floor)).toBe(false)
    expect(isBelow('22.22.1', floor)).toBe(false)
    expect(isBelow('24.0.0', floor)).toBe(false)
    expect(isBelow('22.12.0-nightly2026', floor)).toBe(false)
  })

  it('reads the floor from package.json engines.node', () => {
    expect(nodeFloor()).toEqual(parseFloor(pkg.engines.node))
    expect(nodeFloor()).not.toBeNull()
  })
})

describe('engines.node floor', () => {
  // The launcher's runtime path: `require('electron')` -> electron/install.js ->
  // @electron/get (ESM).
  const runtimePkgs = ['electron', '@electron/get']

  it.each(runtimePkgs)('is not below %s\'s own engines.node', (name) => {
    // Read the file directly: @electron/get's `exports` map doesn't expose ./package.json.
    const depPkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'node_modules', name, 'package.json'), 'utf8'),
    ) as { engines?: { node?: string } }
    const depFloor = parseFloor(depPkg.engines?.node)
    expect(depFloor, `${name} engines.node "${depPkg.engines?.node}" is not a plain >= range`).not.toBeNull()
    const ours = nodeFloor()!
    expect(
      isBelow(ours.join('.'), depFloor!),
      `package.json engines.node ${pkg.engines.node} is below ${name}'s ${depPkg.engines?.node}`,
    ).toBe(false)
  })

  it('is the floor the README install section states', () => {
    const [major, minor] = nodeFloor()!
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')
    expect(readme).toContain(`Needs Node.js ${major}.${minor}+`)
  })

  it('landing-page price-tag note says the installer needs no Node', () => {
    const copy = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, 'session-manager-operations/design-mocks/landing-v2/copy.json'),
        'utf8',
      ),
    ) as { priceTag: { note: string } }
    expect(copy.priceTag.note).toContain('no Node')
    expect(copy.priceTag.note).not.toMatch(/Node \d+\.\d+\+/)
  })
})

describe('bin/cli.cjs when require(\'electron\') fails', () => {
  // Preload that makes `require('electron')` throw the way Electron 42's lazy installer does on
  // old Node, and optionally reports a fake Node version. ELECTRON_OVERRIDE_DIST_PATH is a
  // second guard: if the interception ever stopped working, the launcher would spawn a
  // nonexistent binary instead of booting a real second Electron app.
  function runLauncher(fakeNodeVersion?: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-node-floor-'))
    const preload = path.join(dir, 'fail-electron.cjs')
    fs.writeFileSync(
      preload,
      [
        "const Module = require('node:module')",
        'if (process.env.FAKE_NODE_VERSION) {',
        "  Object.defineProperty(process, 'versions', { value: { ...process.versions, node: process.env.FAKE_NODE_VERSION } })",
        '}',
        'const load = Module._load',
        'Module._load = function (request) {',
        "  if (request === 'electron') { const e = new Error('require() of ES Module not supported'); e.code = 'ERR_REQUIRE_ESM'; throw e }",
        '  return load.apply(this, arguments)',
        '}',
      ].join('\n'),
    )
    try {
      return spawnSync(process.execPath, ['-r', preload, path.join(repoRoot, 'bin/cli.cjs')], {
        env: {
          ...process.env,
          FAKE_NODE_VERSION: fakeNodeVersion ?? '',
          ELECTRON_OVERRIDE_DIST_PATH: path.join(dir, 'no-electron'),
        },
        encoding: 'utf8',
        timeout: 20_000,
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it.skipIf(process.platform === 'win32')('names an old Node as the cause, not the network', () => {
    const r = runLauncher('18.20.4')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`Node.js ${nodeFloor()!.join('.')} or newer is required`)
    expect(r.stderr).toContain('this is Node 18.20.4')
    expect(r.stderr).not.toContain('network issue')
  })

  it.skipIf(process.platform === 'win32')('keeps the network diagnosis on a supported Node', () => {
    const r = runLauncher()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('its binary download did not complete')
    expect(r.stderr).not.toContain('or newer is required')
  })
})
