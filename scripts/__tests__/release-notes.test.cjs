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

describe('release-notes.cjs upgrade-note rewriting', () => {
  let repo2
  const NOTE = [
    '# Big change',
    '',
    'See [contract](../session-manager-operations/architecture/external-contract.md#v1),',
    '[local](README.md), [root](/docs/x.md), [site](https://example.com/a), [mail](mailto:a@b.c) and [here](#big-change).',
    '',
    '## Details',
    '',
    '##### Deep',
    '',
    '###### Deepest',
  ].join('\n')
  const g = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
      cwd: repo2, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    })
  const run2 = (...args) => spawnSync(process.execPath, [SCRIPT, '--repo', repo2, ...args], { encoding: 'utf8' })

  beforeAll(() => {
    repo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-links-'))
    g('init', '-q', '-b', 'main')
    g('commit', '-q', '--allow-empty', '-m', 'feat: first')
    g('tag', 'v1.0.0')
    fs.mkdirSync(path.join(repo2, 'release-notes'))
    fs.writeFileSync(path.join(repo2, 'release-notes', 'after-v1.0.0.md'), NOTE + '\n')
    g('add', '.')
    g('commit', '-q', '-m', 'docs: note without package.json')
    g('tag', 'v1.1.0')
    fs.writeFileSync(path.join(repo2, 'package.json'), JSON.stringify({ name: 'x', repository: { type: 'git', url: 'git+https://github.com/acme/widget.git' } }))
    g('add', '.')
    g('commit', '-q', '-m', 'chore: package.json')
    g('tag', 'v1.2.0')
    fs.writeFileSync(path.join(repo2, 'release-notes', 'after-v1.0.0.md'), 'long note ' + 'y'.repeat(5000) + '\n')
    g('add', '.')
    g('commit', '-q', '-m', 'docs: long note')
    g('tag', 'v1.3.0')
  })

  afterAll(() => {
    if (repo2) fs.rmSync(repo2, { recursive: true, force: true })
  })

  it('rewrites relative links to blob URLs at the tag and leaves absolute links and anchors alone', () => {
    const r = run2('--tag', 'v1.2.0', '--prev', 'v1.0.0')
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    const base = 'https://github.com/acme/widget/blob/v1.2.0/'
    expect(r.stdout).toContain(`[contract](${base}session-manager-operations/architecture/external-contract.md#v1)`)
    expect(r.stdout).toContain(`[local](${base}release-notes/README.md)`)
    expect(r.stdout).toContain(`[root](${base}docs/x.md)`)
    expect(r.stdout).toContain('[site](https://example.com/a)')
    expect(r.stdout).toContain('[mail](mailto:a@b.c)')
    expect(r.stdout).toContain('[here](#big-change)')
  })

  it('repoSlug parses repository.url, null without package.json', () => {
    const { repoSlug } = require(SCRIPT)
    expect(repoSlug(repo2, 'v1.2.0')).toBe('acme/widget')
    expect(repoSlug(repo2, 'v1.1.0')).toBe(null)
  })

  it('leaves links as they are and warns once without a repository url', () => {
    const r = run2('--tag', 'v1.1.0', '--prev', 'v1.0.0')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('[contract](../session-manager-operations/architecture/external-contract.md#v1)')
    expect(r.stdout).toContain('[local](README.md)')
    expect(r.stderr.trim().split('\n')).toHaveLength(1)
    expect(r.stderr).toContain('warning')
  })

  it('demotes note headings two levels, capped at ######', () => {
    const out = run2('--tag', 'v1.2.0', '--prev', 'v1.0.0').stdout
    expect(out.startsWith('## Upgrade notes\n\n### Big change\n')).toBe(true)
    expect(out).toContain('\n#### Details\n')
    expect(out).toContain('\n###### Deep\n')
    expect(out).toContain('\n###### Deepest\n')
    expect(out).not.toMatch(/^# /m)
    expect(out).not.toMatch(/^#{7}/m)
    expect(out).toContain('\n## Changes since v1.0.0\n')
  })

  it('truncates an upgrade note longer than --max-chars and stays within the cap', () => {
    const max = 1000
    const r = run2('--tag', 'v1.3.0', '--prev', 'v1.0.0', '--max-chars', String(max))
    expect(r.status).toBe(0)
    expect(r.stdout.length).toBeLessThanOrEqual(max)
    const marker = '\n\n…(upgrade notes truncated)\n'
    const idx = r.stdout.indexOf(marker)
    expect(idx).toBeGreaterThan(0)
    const head = r.stdout.slice(0, idx + marker.length)
    expect(head.endsWith('…(upgrade notes truncated)\n')).toBe(true)
    expect(head.startsWith('## Upgrade notes\n\nlong note yyy')).toBe(true)
  })

  it.each([['abc'], ['0'], ['-5'], ['1.5']])('refuses --max-chars %s', (v) => {
    const r = run2('--tag', 'v1.2.0', '--prev', 'v1.0.0', '--max-chars', v)
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr.trim()).toBe('release-notes: --max-chars must be a positive integer')
  })
})

describe('release-notes.cjs edge cases', () => {
  let repo3
  const g = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
      cwd: repo3, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    })
  const run3 = (...args) => spawnSync(process.execPath, [SCRIPT, '--repo', repo3, ...args], { encoding: 'utf8' })
  const NOTE = [
    '# Title',
    '',
    '```',
    '# not a heading',
    '[x](rel.md)',
    '```',
    '~~~',
    '## also not',
    '~~~',
    '',
    'Titled [t](a/b.md "the title") link and [r][ref].',
    '',
    '[ref]: c.md',
    '[ref2]: d.md "ref title"',
    '[abs]: https://example.com/z',
  ].join('\n')

  beforeAll(() => {
    repo3 = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-edge-'))
    g('init', '-q', '-b', 'main')
    g('commit', '-q', '--allow-empty', '-m', 'feat: first')
    g('tag', 'v1.0.0')
    fs.mkdirSync(path.join(repo3, 'release-notes'))
    fs.writeFileSync(path.join(repo3, 'package.json'), JSON.stringify({ name: 'x', repository: 'https://github.com/acme/widget' }))
    fs.writeFileSync(path.join(repo3, 'release-notes', 'after-v1.0.0.md'), NOTE + '\n')
    g('add', '.')
    g('commit', '-q', '-m', 'docs: note')
    g('tag', 'v1.1.0')
    const lines = Array.from({ length: 200 }, (_, i) => `line number ${i} of the long note`)
    fs.writeFileSync(path.join(repo3, 'release-notes', 'after-v1.0.0.md'), lines.join('\n') + '\n')
    g('add', '.')
    g('commit', '-q', '-m', 'docs: long')
    g('tag', 'v1.2.0')
  })
  afterAll(() => {
    if (repo3) fs.rmSync(repo3, { recursive: true, force: true })
  })

  it('leaves fenced blocks unchanged', () => {
    const out = run3('--tag', 'v1.1.0', '--prev', 'v1.0.0').stdout
    expect(out).toContain('```\n# not a heading\n[x](rel.md)\n```')
    expect(out).toContain('~~~\n## also not\n~~~')
    expect(out).toContain('### Title')
  })

  it('rewrites reference definitions and titled inline links', () => {
    const out = run3('--tag', 'v1.1.0', '--prev', 'v1.0.0').stdout
    const base = 'https://github.com/acme/widget/blob/v1.1.0/release-notes/'
    expect(out).toContain(`[ref]: ${base}c.md\n`)
    expect(out).toContain(`[ref2]: ${base}d.md "ref title"`)
    expect(out).toContain(`[t](${base}a/b.md "the title")`)
    expect(out).toContain('[abs]: https://example.com/z')
  })

  it('truncates at a line boundary and keeps the marker within the cap', () => {
    const max = 1000
    const out = run3('--tag', 'v1.2.0', '--prev', 'v1.0.0', '--max-chars', String(max)).stdout
    expect(out.length).toBeLessThanOrEqual(max)
    const marker = '\n\n…(upgrade notes truncated)\n'
    const idx = out.indexOf(marker)
    expect(idx).toBeGreaterThan(0)
    expect(out.slice(0, idx).split('\n').pop()).toMatch(/^line number \d+ of the long note$/)
  })

  it('the real 0.142.0 note: title becomes ###, link pinned to the tag', () => {
    const real = fs.readFileSync(path.join(ROOT, 'release-notes', 'after-v0.142.0.md'), 'utf8')
    expect(real.startsWith('# ')).toBe(true)
    expect(real).not.toContain('github.com')
    // HEAD's tree may predate the working-tree note, so run the script on a temp repo holding it.
    const g4 = (...args) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
        cwd: repo3, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      })
    fs.writeFileSync(path.join(repo3, 'release-notes', 'after-v1.0.0.md'), real)
    g4('add', '.')
    g4('commit', '-q', '-m', 'docs: real note')
    const out = run3('--tag', 'HEAD', '--prev', 'v1.0.0').stdout
    expect(out).toMatch(/^### Fine-grained/m)
    expect(out).not.toMatch(/^#{4,} Fine-grained/m)
    expect(out).toMatch(/\(https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/HEAD\/session-manager-operations\/architecture\/external-contract\.md\)/)
  })
})

describe('release-notes.cjs fence rules', () => {
  const { mapOutsideFences, openFenceAt, buildNotes } = require(SCRIPT)
  const upper = (n) => mapOutsideFences(n, (l) => l.toUpperCase())

  it('a four-backtick block containing ``` keeps inner lines and the line after the inner ```', () => {
    const note = ['a', '````md', '```js', 'inner', '```', 'after inner', '````', 'b'].join('\n')
    expect(upper(note)).toBe(['A', '````md', '```js', 'inner', '```', 'after inner', '````', 'B'].join('\n'))
  })

  it('a ``` line with an info string inside a fence does not close it', () => {
    const note = ['```', '```js', 'still fenced', '```', 'out'].join('\n')
    expect(upper(note)).toBe(['```', '```js', 'still fenced', '```', 'OUT'].join('\n'))
  })

  it('a closer must use the opener character', () => {
    expect(upper(['~~~', '```', 'x', '~~~', 'y'].join('\n'))).toBe(['~~~', '```', 'x', '~~~', 'Y'].join('\n'))
  })

  it('openFenceAt reports the open fence or null', () => {
    expect(openFenceAt('a\n````\n```\nx')).toEqual({ ch: '`', len: 4 })
    expect(openFenceAt('```\nx\n```')).toBeNull()
  })

  it('truncation inside a fence ends with a closing fence, then the marker, within the cap', () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-fence-'))
    try {
      const g = (...a) => execFileSync('git', ['-C', r, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      g('init', '-q', '-b', 'main')
      g('commit', '-q', '--allow-empty', '-m', 'feat: first')
      g('tag', 'v1.0.0')
      fs.mkdirSync(path.join(r, 'release-notes'))
      const body = Array.from({ length: 200 }, (_, i) => `code line ${i}`).join('\n')
      fs.writeFileSync(path.join(r, 'release-notes', 'after-v1.0.0.md'), 'intro\n\n````\n' + body + '\n````\n')
      g('add', 'release-notes')
      g('commit', '-q', '-m', 'docs: note')
      g('tag', 'v1.1.0')
      const max = 1000
      const out = buildNotes({ repo: r, tag: 'v1.1.0', prev: 'v1.0.0', maxChars: max })
      expect(out.length).toBeLessThanOrEqual(max)
      const marker = '\n\n…(upgrade notes truncated)\n'
      const idx = out.indexOf(marker)
      expect(idx).toBeGreaterThan(0)
      expect(out.slice(0, idx).endsWith('\n````')).toBe(true)
      expect(openFenceAt(out.slice(0, idx))).toBeNull()
    } finally {
      fs.rmSync(r, { recursive: true, force: true })
    }
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
