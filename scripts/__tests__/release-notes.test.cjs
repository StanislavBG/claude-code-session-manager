// scripts/release-notes.cjs — temp git repo, no network.
// Run: timeout 120 npx vitest run scripts/__tests__/release-notes.test.cjs
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { execFileSync, spawnSync } = require('node:child_process')
const yaml = require('js-yaml')

const ROOT = path.join(__dirname, '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'release-notes.cjs')
const MAX = 120000
const COMMITTED_NOTE = 'Restart the app once after upgrading.\n\nSettings move to the new pane.'

let repo
const git = (...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
    cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  })
const commit = (msg) => git('commit', '-q', '--allow-empty', '-m', msg)
const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--repo', repo, ...args], { encoding: 'utf8' })

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-test-'))
  git('init', '-q', '-b', 'main')
  commit('feat: first')
  git('tag', 'v1.0.0')
  commit('feat: add widget')
  commit('chore(release): 1.0.1')
  git('checkout', '-q', '-b', 'side')
  commit('fix: side branch fix')
  git('checkout', '-q', 'main')
  git('merge', '-q', '--no-ff', '-m', 'Merge branch side', 'side')
  fs.mkdirSync(path.join(repo, 'release-notes'))
  fs.writeFileSync(path.join(repo, 'release-notes', 'after-v1.0.0.md'), COMMITTED_NOTE + '\n')
  git('add', 'release-notes/after-v1.0.0.md')
  commit('docs: upgrade note for next release')
  git('tag', 'v1.1.0')
  // Uncommitted working-tree edit that must never be read.
  fs.writeFileSync(path.join(repo, 'release-notes', 'after-v1.0.0.md'), 'WORKING TREE ONLY\n')

  // v2.0.0: many long-subject commits after v1.1.0, built with fast-import for speed.
  const parent = git('rev-parse', 'v1.1.0').trim()
  let stream = ''
  for (let i = 0; i < 300; i++) {
    const msg = `feat: bulk ${i} ${'x'.repeat(600)}\n`
    stream += `commit refs/heads/bulk\ncommitter t <t@example.invalid> ${1700000000 + i} +0000\n`
    stream += `data ${Buffer.byteLength(msg)}\n${msg}`
    stream += i === 0 ? `from ${parent}\n\n` : '\n'
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input: stream })
  git('tag', 'v2.0.0', 'bulk')
})

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true })
})

describe('release-notes.cjs', () => {
  it('puts the committed upgrade note first, read from the tag tree', () => {
    const r = run('--tag', 'v1.1.0', '--prev', 'v1.0.0')
    expect(r.status).toBe(0)
    expect(r.stdout.startsWith('## Upgrade notes\n\n' + COMMITTED_NOTE + '\n\n## Changes since v1.0.0\n')).toBe(true)
    expect(r.stdout).not.toContain('WORKING TREE ONLY')
  })

  it('lists non-merge commits and drops merge and chore(release) subjects', () => {
    const out = run('--tag', 'v1.1.0', '--prev', 'v1.0.0').stdout
    const changes = out.split('## Changes since v1.0.0\n\n')[1].trim().split('\n')
    expect(changes).toHaveLength(3)
    for (const l of changes) expect(l).toMatch(/^- .+ \([0-9a-f]{7,}\)$/)
    expect(out).toContain('- feat: add widget (')
    expect(out).toContain('- fix: side branch fix (')
    expect(out).toContain('- docs: upgrade note for next release (')
    expect(out).not.toContain('Merge branch')
    expect(out).not.toContain('chore(release)')
    expect(out).not.toContain('feat: first')
  })

  it('detects the previous tag when --prev is omitted', () => {
    const r = run('--tag', 'v1.1.0')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('## Changes since v1.0.0')
  })

  it('has no upgrade section when the file is absent', () => {
    const r = run('--tag', 'v2.0.0')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('## Changes since v1.1.0')
    expect(r.stdout).not.toContain('## Upgrade notes')
    expect(r.stdout.startsWith('## Changes since v1.1.0')).toBe(true)
  })

  it('cuts the commit list at 120000 characters and says how many were left out', () => {
    const r = run('--tag', 'v2.0.0', '--prev', 'v1.1.0')
    expect(r.status).toBe(0)
    expect(r.stdout.length).toBeLessThanOrEqual(MAX)
    const listed = r.stdout.split('\n').filter((l) => l.startsWith('- feat: bulk')).length
    expect(listed).toBeGreaterThan(0)
    expect(listed).toBeLessThan(300)
    const last = r.stdout.trim().split('\n').pop()
    expect(last).toBe(`…and ${300 - listed} more commits not listed.`)
  })

  it('exits 1 with a one-line diagnostic on an unknown ref', () => {
    const r = run('--tag', 'v9.9.9')
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr.trim().split('\n')).toHaveLength(1)
    expect(r.stderr).toContain('v9.9.9')
  })

  it('exits 1 when there is no previous tag', () => {
    const r = run('--tag', 'v1.0.0')
    expect(r.status).toBe(1)
    expect(r.stderr.trim().split('\n')).toHaveLength(1)
  })
})

describe('release.yml finalize-release', () => {
  const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8'))
  const steps = wf.jobs['finalize-release'].steps

  it('checks out the tag with full history and sets up node 22', () => {
    const co = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'))
    expect(co).toBeTruthy()
    expect(co.uses).toBe('actions/checkout@v4')
    expect(co.with['fetch-depth']).toBe(0)
    const node = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node@'))
    expect(String(node.with['node-version'])).toBe('22')
  })

  it('passes --notes-file to gh release edit and fails loudly', () => {
    const edit = steps.find((s) => typeof s.run === 'string' && s.run.includes('gh release edit'))
    expect(edit).toBeTruthy()
    expect(edit.run).toMatch(/gh release edit "\$TAG" --repo "\$REPO" --draft=false --latest --notes-file /)
    expect(edit.run).toContain('scripts/release-notes.cjs')
    expect(edit.run).toContain('::error::')
  })
})
