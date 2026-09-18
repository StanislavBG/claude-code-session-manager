'use strict'

/**
 * write-build-info.cjs — resolves this build's identity from the PUBLISHING
 * checkout and writes src/main/build-info.json = { version, gitSha,
 * gitShortSha, gitBranch, builtAt, dirty }.
 *
 * This is the only reliable moment git is available: the npx-cached install
 * that actually runs in production ships no .git directory at all (see
 * src/main/lib/buildIdentity.cjs's header), so identity must be baked into
 * the artifact here, at publish time, rather than resolved at runtime.
 *
 * src/main/build-info.json is a POSITIVE .gitignore entry — never committed
 * — and reaches the published tarball only because package.json's `files`
 * array lists `src/main/` (files[] overrides .gitignore; proven by dist/
 * shipping in the installed tarball while `dist` itself is gitignored). Run
 * from both `prepack` and `prepublishOnly` so both `npm pack` and
 * `npm publish` produce a real, non-null build-info.json.
 *
 * `dirty` is computed BEFORE this script writes build-info.json, so the
 * write itself (an untracked, gitignored file) can never make the tree look
 * dirty to itself.
 *
 * Usage: node scripts/write-build-info.cjs
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const OUT_PATH = path.join(REPO_ROOT, 'src', 'main', 'build-info.json')

function git(args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', timeout: 10000 }).trim()
}

function resolvePackageVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
  return pkg.version
}

function buildInfo() {
  // Computed first, before any write below, so the artifact's own creation
  // can never be the thing that makes `dirty` true.
  const dirty = git(['status', '--porcelain']).length > 0
  return {
    version: resolvePackageVersion(),
    gitSha: git(['rev-parse', 'HEAD']),
    gitShortSha: git(['rev-parse', '--short', 'HEAD']),
    gitBranch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    builtAt: new Date().toISOString(),
    dirty,
  }
}

function writeBuildInfo() {
  const info = buildInfo()
  const tmp = `${OUT_PATH}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, OUT_PATH)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* tmp never created or already gone */ }
    throw e
  }
  return info
}

if (require.main === module) {
  const info = writeBuildInfo()
  process.stdout.write(`[write-build-info] wrote ${OUT_PATH} (${info.gitShortSha}${info.dirty ? ' dirty' : ''})\n`)
}

module.exports = { buildInfo, writeBuildInfo, OUT_PATH }
