'use strict'

/**
 * sync-settings-schema.cjs — refreshes src/renderer/data/claude-settings-schema.json
 * from the live upstream schemastore snapshot, and writes provenance to a
 * sibling claude-settings-schema.meta.json.
 *
 * `json.schemastore.org` 301-redirects to `www.schemastore.org` — request the
 * www host directly but still pass redirect: 'follow'.
 *
 * config.cjs's writeTextAtomic (the repo's shared tmp+rename helper) refuses
 * this destination — its validateWrite() only allows `~/.claude`, a
 * project's `.claude/` subtree, or a declared ops namespace, none of which
 * cover src/renderer/data/ inside the repo itself — so this script implements
 * its own tmp+rename instead of re-using it (still atomic, per CLAUDE.md's
 * Avoid list on non-atomic writes; just not the same call site).
 *
 * Usage:
 *   node scripts/sync-settings-schema.cjs           refresh both files
 *   node scripts/sync-settings-schema.cjs --check    exit 1 on drift, never writes
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const SOURCE_URL = 'https://www.schemastore.org/claude-code-settings.json'
const SCHEMA_PATH = path.join(__dirname, '..', 'src/renderer/data/claude-settings-schema.json')
const META_PATH = path.join(__dirname, '..', 'src/renderer/data/claude-settings-schema.meta.json')

/**
 * Pure comparison of two JSON-Schema `properties` objects. No fetch, no I/O —
 * this is the function the vitest fixture test exercises directly.
 */
function diffSchemas(localProps, upstreamProps) {
  const added = []
  const changed = []
  const removed = []
  const localKeys = new Set(Object.keys(localProps || {}))
  const upstreamKeys = new Set(Object.keys(upstreamProps || {}))
  for (const key of upstreamKeys) {
    if (!localKeys.has(key)) {
      added.push(key)
    } else if (JSON.stringify(localProps[key]) !== JSON.stringify(upstreamProps[key])) {
      changed.push(key)
    }
  }
  for (const key of localKeys) {
    if (!upstreamKeys.has(key)) removed.push(key)
  }
  added.sort()
  changed.sort()
  removed.sort()
  return { added, changed, removed }
}

async function fetchUpstreamSchema() {
  let response
  try {
    response = await fetch(SOURCE_URL, { redirect: 'follow' })
  } catch (e) {
    throw new Error(`failed to fetch ${SOURCE_URL}: ${e.message}`)
  }
  if (response.status !== 200) {
    throw new Error(`${SOURCE_URL} responded with HTTP ${response.status}`)
  }
  let body
  try {
    body = await response.json()
  } catch (e) {
    throw new Error(`${SOURCE_URL} did not return parseable JSON: ${e.message}`)
  }
  if (!body || typeof body.properties !== 'object' || body.properties === null) {
    throw new Error(`${SOURCE_URL} response has no "properties" object`)
  }
  return body
}

function writeFileAtomic(absPath, contents) {
  const dir = path.dirname(absPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    fs.writeFileSync(tmp, contents, 'utf8')
    fs.renameSync(tmp, absPath)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* tmp never created or already gone */ }
    throw e
  }
}

function readLocalSchema() {
  try {
    return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  } catch (e) {
    throw new Error(`failed to read/parse ${SCHEMA_PATH}: ${e.message}`)
  }
}

async function main() {
  const checkOnly = process.argv.includes('--check')

  const local = readLocalSchema()
  const upstream = await fetchUpstreamSchema()
  const diff = diffSchemas(local.properties, upstream.properties)
  const dirty = diff.added.length > 0 || diff.changed.length > 0 || diff.removed.length > 0

  if (checkOnly) {
    if (!dirty) {
      console.log('up to date: local snapshot matches upstream')
      process.exit(0)
    }
    console.log(`${diff.added.length} keys added, ${diff.changed.length} changed, ${diff.removed.length} removed`)
    process.exit(1)
  }

  const schemaText = JSON.stringify(upstream, null, 2) + '\n'
  writeFileAtomic(SCHEMA_PATH, schemaText)

  const sha256 = crypto.createHash('sha256').update(schemaText, 'utf8').digest('hex')
  const meta = {
    sourceUrl: SOURCE_URL,
    fetchedAt: new Date().toISOString(),
    sha256,
    keyCount: Object.keys(upstream.properties).length,
  }
  writeFileAtomic(META_PATH, JSON.stringify(meta, null, 2) + '\n')

  console.log(`refreshed ${SCHEMA_PATH} (${meta.keyCount} keys): ${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} removed`)
  process.exit(0)
}

module.exports = { diffSchemas }

if (require.main === module) {
  main().catch((e) => {
    console.error(`HALT: ${e.message}`)
    process.exit(1)
  })
}
