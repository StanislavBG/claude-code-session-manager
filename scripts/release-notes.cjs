#!/usr/bin/env node
// Composes a GitHub release body for a tag: an optional upgrade note read from the
// tag's own tree (release-notes/after-<prev>.md), then the commit subjects since prev.
// Usage: node scripts/release-notes.cjs --tag <ref> [--prev <tag>] [--repo <dir>] [--max-chars <n>]
//   --max-chars: positive integer cap on the body length (default 120000, GitHub's release-body limit
//   leaves headroom above it). Relative links in the note become github.com blob URLs at <ref>; its
//   headings are demoted two levels so they nest under '## Upgrade notes'.
// Convention: release-notes/README.md. Invoked by .github/workflows/release.yml (finalize-release).
'use strict'

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const MAX_CHARS = 120000

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

function tryGit(repo, args) {
  try {
    return git(repo, args)
  } catch {
    return null
  }
}

class NotesError extends Error {}

function resolveCommit(repo, ref) {
  const out = tryGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return out ? out.trim() : null
}

// owner/repo from the tag tree's package.json `repository` (string or { url }); null on any failure.
function repoSlug(repo, tag) {
  try {
    const r = JSON.parse(git(repo, ['show', `${tag}:package.json`])).repository
    const url = typeof r === 'string' ? r : r && r.url
    const m = typeof url === 'string' ? url.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/) : null
    return m ? m[1] : null
  } catch {
    return null
  }
}

const INLINE_RE = /\]\(([^)\s]+)(\s+"[^"]*")?\)/g
const REF_RE = /^(\s*\[[^\]]+\]:\s*)(\S+)/
const isRelative = (target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#')

// CommonMark fences: an opener is 3+ backticks or tildes; it closes only on a line of the same
// character, at least as long, with nothing after it. Returns the next fence state for one line.
function stepFence(fence, line) {
  if (fence) {
    const c = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/)
    return c && c[1][0] === fence.ch && c[1].length >= fence.len ? null : fence
  }
  const o = line.match(/^\s{0,3}(`{3,}|~{3,})/)
  return o ? { ch: o[1][0], len: o[1].length } : null
}

// The fence still open after scanning text ({ ch, len }), or null.
function openFenceAt(text) {
  let fence = null
  for (const line of text.split('\n')) fence = stepFence(fence, line)
  return fence
}

// Apply fn to every line outside ``` / ~~~ fenced blocks; fenced lines pass through unchanged.
function mapOutsideFences(note, fn) {
  let fence = null
  return note
    .split('\n')
    .map((line) => {
      const wasOpen = fence !== null
      fence = stepFence(fence, line)
      if (wasOpen || fence) return line // opener, fenced content, or closer
      return fn(line)
    })
    .join('\n')
}

// A release body has no base path, so relative targets (resolved from release-notes/) become blob URLs.
function blobUrl(target, slug, tag) {
  let p = target.startsWith('/') ? target.slice(1) : path.posix.join('release-notes', target)
  p = path.posix.normalize(p)
  while (p.startsWith('../')) p = p.slice(3)
  return `https://github.com/${slug}/blob/${tag}/${p}`
}

function rewriteLinks(note, slug, tag) {
  if (!slug) return note
  return mapOutsideFences(note, (line) => {
    line = line.replace(REF_RE, (whole, pre, target) => (isRelative(target) ? pre + blobUrl(target, slug, tag) : whole))
    return line.replace(INLINE_RE, (whole, target, title) => (isRelative(target) ? `](${blobUrl(target, slug, tag)}${title || ''})` : whole))
  })
}

function hasRelativeLinks(note) {
  let found = false
  mapOutsideFences(note, (line) => {
    const r = line.match(REF_RE)
    if (r && isRelative(r[2])) found = true
    for (const m of line.matchAll(INLINE_RE)) if (isRelative(m[1])) found = true
    return line
  })
  return found
}

// Nest the note under '## Upgrade notes': # -> ###, ## -> ####, capped at ######.
function demoteHeadings(note) {
  return mapOutsideFences(note, (line) =>
    line.replace(/^(#{1,6})(\s)/, (_, hashes, sp) => '#'.repeat(Math.min(6, hashes.length + 2)) + sp))
}

function buildNotes({ repo = process.cwd(), tag, prev, maxChars = MAX_CHARS } = {}) {
  if (!tag) throw new NotesError('release-notes: --tag <ref> is required')
  if (!resolveCommit(repo, tag)) throw new NotesError(`release-notes: unknown ref '${tag}'`)
  if (!prev) {
    const out = tryGit(repo, ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${tag}^`])
    prev = out ? out.trim() : ''
    if (!prev) throw new NotesError(`release-notes: no previous v* tag before '${tag}'`)
  } else if (!resolveCommit(repo, prev)) {
    throw new NotesError(`release-notes: unknown previous tag '${prev}'`)
  }

  // Read from the tag's tree, never the working tree.
  const notePath = `release-notes/after-${prev}.md`
  const hasNote = tryGit(repo, ['cat-file', '-e', `${tag}:${notePath}`]) !== null
  let upgrade = hasNote ? git(repo, ['show', `${tag}:${notePath}`]).trim() : ''
  if (upgrade) {
    const needsSlug = hasRelativeLinks(upgrade)
    if (needsSlug) {
      const slug = repoSlug(repo, tag)
      if (slug) upgrade = rewriteLinks(upgrade, slug, tag)
      else process.stderr.write(`release-notes: warning: no GitHub repository url in ${tag}:package.json; relative links left as they are\n`)
    }
    upgrade = demoteHeadings(upgrade)
  }

  const log = git(repo, ['log', '--no-merges', '--format=%h%x09%s', `${prev}..${tag}`])
  const lines = []
  for (const row of log.split('\n')) {
    if (!row) continue
    const tab = row.indexOf('\t')
    const sha = row.slice(0, tab)
    const subject = row.slice(tab + 1)
    if (subject.startsWith('chore(release):')) continue
    lines.push(`- ${subject} (${sha})`)
  }

  let head = ''
  if (upgrade) head += `## Upgrade notes\n\n${upgrade}\n\n`
  head += `## Changes since ${prev}\n\n`
  if (head.length > maxChars) {
    const marker = '\n\n…(upgrade notes truncated)\n'
    let reserve = 0
    let cut
    let close = ''
    for (let i = 0; i < 4; i++) {
      cut = head.slice(0, Math.max(0, maxChars - marker.length - 200 - reserve))
      const nl = cut.lastIndexOf('\n')
      // Keep the raw slice when the note has no line break to cut back to (one very long line).
      if (nl > '## Upgrade notes\n\n'.length) cut = cut.slice(0, nl)
      const open = openFenceAt(cut)
      close = open ? '\n' + open.ch.repeat(open.len) : ''
      if (close.length <= reserve) break
      reserve = close.length
    }
    head = cut + close + marker
  }

  let body = head
  if (lines.length === 0) body += '_No changes._\n'
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] + '\n'
    const remaining = lines.length - i - 1
    const omitLine = (n) => `\n…and ${n} more commit${n === 1 ? '' : 's'} not listed.\n`
    // Reserve room for the omission line unless this is the last commit.
    const reserve = remaining > 0 ? omitLine(remaining + 1).length : 0
    if (body.length + line.length + reserve > maxChars) {
      body += omitLine(lines.length - i)
      break
    }
    body += line
  }
  return body
}

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const take = () => {
      const v = argv[++i]
      if (v === undefined) throw new NotesError(`release-notes: ${a} needs a value`)
      return v
    }
    if (a === '--tag') opts.tag = take()
    else if (a === '--prev') opts.prev = take()
    else if (a === '--repo') opts.repo = take()
    else if (a === '--max-chars') {
      const n = Number(take())
      if (!Number.isInteger(n) || n <= 0) throw new NotesError('release-notes: --max-chars must be a positive integer')
      opts.maxChars = n
    }
    else throw new NotesError(`release-notes: unknown argument '${a}'`)
  }
  return opts
}

function main(argv) {
  try {
    process.stdout.write(buildNotes(parseArgs(argv)))
    return 0
  } catch (err) {
    const msg = err instanceof NotesError ? err.message : `release-notes: ${String(err && err.message || err).split('\n')[0]}`
    process.stderr.write(msg + '\n')
    return 1
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))

module.exports = { buildNotes, mapOutsideFences, openFenceAt, parseArgs, repoSlug, MAX_CHARS }
