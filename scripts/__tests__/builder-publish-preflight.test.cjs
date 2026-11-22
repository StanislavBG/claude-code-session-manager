// builder publish-preflight.cjs — fake npm/gh runner, no network, no real child processes.
// Run: timeout 300 npx vitest run scripts/__tests__/builder-publish-preflight.test.cjs
import { describe, it, expect } from 'vitest'
const path = require('node:path')

const { preflight } = require(path.join(
  __dirname, '..', '..', 'plugins', 'session-manager-dev', 'skills', 'builder', 'scripts', 'publish-preflight.cjs',
))

const CWD = '/fake/proj'
const REG = 'https://registry.npmjs.org/'
const FAKE_TOKEN = 'npm_FAKEtokenFAKEtokenFAKEtokenFAKE1234'
const NOW = Date.parse('2026-11-21T12:00:00Z')
const DAY = 86400000
const PKG = 'claude-code-session-manager'

function tokenEntry(over = {}) {
  return {
    name: 'publish-token',
    key: '00000000-0000-0000-0000-000000000000',
    token: 'npm_FAKE...1234',
    expiry: new Date(NOW + 60 * DAY).toISOString(),
    bypass_2fa: true,
    revoked: null,
    permissions: [{ name: 'package', action: 'write' }],
    scopes: [{ name: null, type: 'package' }],
    ...over,
  }
}

const ok = (stdout) => ({ status: 0, stdout, stderr: '' })
const fail = (stderr) => ({ status: 1, stdout: '', stderr })

function setup({ tokens = [tokenEntry()], whoami = ok('alice\n'), ci = false, runs = {} } = {}) {
  const table = {
    'npm config get registry': ok(REG + '\n'),
    'npm config get userconfig': ok('/fake/home/.npmrc\n'),
    [`npm whoami --registry ${REG}`]: whoami,
    [`npm token list --json --registry ${REG}`]: ok(JSON.stringify(tokens)),
    [`npm owner ls ${PKG} --registry ${REG}`]: ok('alice alice@example.com\n'),
    ...runs,
  }
  const calls = []
  const run = (cmd, args, o) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, o })
    return table[`${cmd} ${args.join(' ')}`] || fail('unexpected command')
  }
  const files = {
    [path.join(CWD, 'package.json')]: JSON.stringify({ name: PKG }),
    '/fake/home/.npmrc': `//registry.npmjs.org/:_authToken=${FAKE_TOKEN}\n`,
  }
  if (ci) {
    files[path.join(CWD, '.github', 'workflows', 'release.yml')] =
      'name: release\njobs:\n  build:\n    runs-on: ubuntu-latest\n  npm-publish:\n    needs: build\n'
  }
  const readFile = (p) => (p in files ? files[p] : null)
  return { opts: { cwd: CWD, run, readFile, env: {}, now: () => NOW }, calls }
}

function assertClean(line) {
  expect(line).not.toContain(FAKE_TOKEN)
  expect(line).not.toContain('FAKEtoken')
  expect(line).not.toMatch(/[\r\n]/)
  expect(line.length).toBeLessThanOrEqual(400)
}

describe('publish-preflight local mode', () => {
  it('blocks when npm whoami fails', async () => {
    const { opts } = setup({ whoami: fail('npm ERR! code ENEEDAUTH\nmore') })
    const r = await preflight(opts)
    expect(r.ok).toBe(false)
    expect(r.line).toBe(
      'NPM_PUBLISH_PREFLIGHT: BLOCKED — npm whoami failed (npm ERR! code ENEEDAUTH): no working npm login on this machine',
    )
    assertClean(r.line)
  })

  it('blocks when the in-use token has bypass_2fa off', async () => {
    const { opts } = setup({ tokens: [tokenEntry({ name: 'other', token: 'npm_ZZZZ...9999' }), tokenEntry({ bypass_2fa: false })] })
    const r = await preflight(opts)
    expect(r.ok).toBe(false)
    expect(r.line).toBe(
      "NPM_PUBLISH_PREFLIGHT: BLOCKED — npm token 'publish-token' has 'Bypass two-factor authentication' off, so npm publish fails E403; regenerate it on npmjs.com with that box ticked",
    )
    assertClean(r.line)
  })

  it('blocks when the in-use token is expired', async () => {
    const { opts } = setup({ tokens: [tokenEntry({ expiry: '2026-11-01T00:00:00.000Z' })] })
    const r = await preflight(opts)
    expect(r.ok).toBe(false)
    expect(r.line).toBe("NPM_PUBLISH_PREFLIGHT: BLOCKED — npm token 'publish-token' expired on 2026-11-01")
    assertClean(r.line)
  })

  it('blocks when the token is revoked, scoped to another package, or the user is not a maintainer', async () => {
    const revoked = await preflight(setup({ tokens: [tokenEntry({ revoked: '2026-11-02' })] }).opts)
    expect(revoked.line).toBe("NPM_PUBLISH_PREFLIGHT: BLOCKED — npm token 'publish-token' is revoked")
    const scoped = await preflight(setup({ tokens: [tokenEntry({ scopes: [{ name: 'other-pkg', type: 'package' }] })] }).opts)
    expect(scoped.line).toBe(`NPM_PUBLISH_PREFLIGHT: BLOCKED — npm token 'publish-token' cannot write ${PKG}`)
    const notOwner = await preflight(setup({ runs: { [`npm owner ls ${PKG} --registry ${REG}`]: ok('bob bob@example.com\n') } }).opts)
    expect(notOwner.line).toBe(`NPM_PUBLISH_PREFLIGHT: BLOCKED — npm user alice is not a maintainer of ${PKG}`)
    for (const r of [revoked, scoped, notOwner]) {
      expect(r.ok).toBe(false)
      assertClean(r.line)
    }
  })

  it('passes with no WARN when the token is far from expiry', async () => {
    const { opts, calls } = setup()
    const r = await preflight(opts)
    expect(r.ok).toBe(true)
    expect(r.line).toBe(`NPM_PUBLISH_PREFLIGHT: OK — local npm token 'publish-token' can publish ${PKG} as alice`)
    assertClean(r.line)
    for (const c of calls) {
      expect(c.o.cwd).toBe(CWD)
      expect(c.o.timeoutMs).toBeGreaterThan(0)
    }
  })

  it('passes with a WARN when the token expires within 14 days', async () => {
    const { opts } = setup({ tokens: [tokenEntry({ expiry: '2026-11-26T12:00:00.000Z' })] })
    const r = await preflight(opts)
    expect(r.ok).toBe(true)
    expect(r.line).toBe(
      `NPM_PUBLISH_PREFLIGHT: OK — local npm token 'publish-token' can publish ${PKG} as alice; WARN: token 'publish-token' expires 2026-11-26 (5 days); renew it before then`,
    )
    assertClean(r.line)
  })

  it('passes with a WARN when token metadata is unreadable', async () => {
    const { opts } = setup({ runs: { [`npm token list --json --registry ${REG}`]: fail('npm ERR! code E403') } })
    const r = await preflight(opts)
    expect(r.ok).toBe(true)
    expect(r.line).toBe(
      `NPM_PUBLISH_PREFLIGHT: OK — local npm login as alice can reach ${PKG}; WARN: token metadata unreadable (npm ERR! code E403); bypass-2FA not verified`,
    )
  })
})

describe('publish-preflight ci mode', () => {
  const runList = 'gh run list --workflow release.yml --limit 20 --json databaseId,headBranch,status,conclusion'
  const runs = (conclusion) => ({
    [runList]: ok(JSON.stringify([
      { databaseId: 9, headBranch: 'main', status: 'completed', conclusion: 'success' },
      { databaseId: 7, headBranch: 'v0.138.0', status: 'completed', conclusion: 'failure' },
    ])),
    'gh run view 7 --json jobs': ok(JSON.stringify({ jobs: [{ name: 'build', conclusion: 'success' }, { name: 'npm-publish', conclusion }] })),
  })

  it('blocks when CI npm-publish failed and the local check blocks, naming both causes', async () => {
    const { opts } = setup({ ci: true, tokens: [tokenEntry({ bypass_2fa: false })], runs: runs('failure') })
    const r = await preflight(opts)
    expect(r.ok).toBe(false)
    expect(r.line).toBe(
      "NPM_PUBLISH_PREFLIGHT: BLOCKED — CI npm-publish failed on v0.138.0 (run 7) and npm token 'publish-token' has 'Bypass two-factor authentication' off, so npm publish fails E403; regenerate it on npmjs.com with that box ticked",
    )
    assertClean(r.line)
  })

  it('passes when CI npm-publish failed but local publish is ready', async () => {
    const r = await preflight(setup({ ci: true, runs: runs('failure') }).opts)
    expect(r.ok).toBe(true)
    expect(r.line).toBe(
      `NPM_PUBLISH_PREFLIGHT: OK — CI npm-publish failed on v0.138.0 (run 7); local publish ready: local npm token 'publish-token' can publish ${PKG} as alice`,
    )
  })

  it('never blocks on CI success or when there is no earlier tag run', async () => {
    const badLocal = [tokenEntry({ bypass_2fa: false })]
    const success = await preflight(setup({ ci: true, tokens: badLocal, runs: runs('success') }).opts)
    expect(success.ok).toBe(true)
    expect(success.line).toBe('NPM_PUBLISH_PREFLIGHT: OK — CI npm-publish succeeded on v0.138.0 (run 7)')
    const none = await preflight(setup({ ci: true, tokens: badLocal, runs: { [runList]: ok('[]') } }).opts)
    expect(none.ok).toBe(true)
    expect(none.line.startsWith('NPM_PUBLISH_PREFLIGHT: OK — CI npm-publish has no earlier tag run to judge; local check: ')).toBe(true)
    assertClean(none.line)
  })
})
