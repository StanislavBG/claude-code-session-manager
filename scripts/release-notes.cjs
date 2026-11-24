#!/usr/bin/env node
// Composes a GitHub release body for a tag: an optional upgrade note read from the
// tag's own tree (release-notes/after-<prev>.md), then the commit subjects since prev.
// Usage: node scripts/release-notes.cjs --tag <ref> [--prev <tag>] [--repo <dir>]
// Convention: release-notes/README.md. Invoked by .github/workflows/release.yml (finalize-release).
'use strict'

const { execFileSync } = require('node:child_process')

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
  const upgrade = hasNote ? git(repo, ['show', `${tag}:${notePath}`]).trim() : ''

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
    head = head.slice(0, Math.max(0, maxChars - marker.length - 200)) + marker
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
    else if (a === '--max-chars') opts.maxChars = Number(take())
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

module.exports = { buildNotes, MAX_CHARS }
