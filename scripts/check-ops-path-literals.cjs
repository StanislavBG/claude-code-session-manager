#!/usr/bin/env node
'use strict'

// Self-policing lint for the ops-root path invariant (PRD 1082): nothing under
// src/main/** or scripts/** may spell the quoted literal 'session-manager-operations'
// except src/main/lib/opsOwnership.cjs (the one resolver — opsPath()/resolveOpsRoot()).
// Files that legitimately can't route through it are allowlisted below with a reason
// (same convention as check-unregistered-tests.cjs). Dev-only: not in package.json `files`.
//
// Second rule, LIVE_ROOT_LITERAL: once every scheduler root resolves through
// src/main/lib/schedulerPaths.cjs, a new os.homedir()/os.tmpdir() join spelling a scheduler-root
// segment (session-manager, scheduled-plans, <x>-worktrees) is how the split-brain returns.
// Scanned across src/main, scripts, tests (incl. __tests__ and .ts); per-file allowlist below.
// This file is excluded by SELF_REL, so its own pattern strings never self-match.
//
// scan(root) is also required by scripts/ops-sweep.cjs (OPS_PATH_LITERAL) with an
// explicit root so that skill still runs against any target project.
// Complexity: O(total bytes) — one pass over every scanned file.

const fs = require('fs')
const path = require('path')

const RESOLVER_REL = 'src/main/lib/opsOwnership.cjs'
const SELF_REL = 'scripts/check-ops-path-literals.cjs'
const SCAN_DIRS = ['src/main', 'scripts']
const SKIP_DIRS = new Set(['__tests__', 'node_modules', 'dist'])
const FILE_RE = /\.(?:cjs|mjs|js)$/
const LITERAL_RE = /(['"])session-manager-operations\1/

// repo-relative path -> reason this file may spell the literal. Whole-file entries.
const ALLOWLIST = new Map([
  ['src/main/lib/cwdClassify.cjs', 'pure cwd classifier: matches the dirname as a path segment, has no project root to resolve'],
  ['scripts/ops-sweep.cjs', "portable across target projects: builds the ops root of an arbitrary targetCwd, cannot import that project's resolver"],
  ['scripts/audit-ops-hygiene.cjs', 'standalone CLI audit script run against a project cwd; not part of the app runtime'],
  ['scripts/check-doc-hierarchy.cjs', 'standalone lint that walks the repo tree for ops docs; no runtime resolver needed'],
  ['scripts/cleanup-worktree-ops-stubs.cjs', 'one-shot cleanup that matches stray ops dirnames inside worktrees; must not normalize them away'],
  ['scripts/cleanup-nested-queue-stubs.cjs', 'one-shot cleanup that detects the doubled ops dirname; must not normalize it away'],
  ['scripts/hooks/guard-inline-implementation.cjs', 'installed to ~/.claude/session-manager/hooks via shim; runs outside the repo and cannot require opsOwnership'],
])

const SCHEDULER_PATHS_REL = 'src/main/lib/schedulerPaths.cjs'
const LIVE_SCAN_DIRS = ['src/main', 'scripts', 'tests']
const LIVE_SKIP_DIRS = new Set(['node_modules', 'dist'])
const LIVE_FILE_RE = /\.(?:cjs|mjs|js|ts|tsx)$/
const HOME_OR_TMP_RE = /\b(?:homedir|tmpdir)\(\)/
// '.claude' is not matched alone (agents/projects/settings are Claude Code's own dirs, not
// scheduler roots); it counts through the session-manager segment that follows it.
// The 'Projects' checkout dir (~/Projects/session-manager, the repo clone itself) is likewise
// not a scheduler root. '.config' is NOT exempted — everything under
// ~/.config/session-manager has migrated to ~/.claude/session-manager, so a new join under
// the old dir is exactly the split-brain this rule exists to catch.
const LIVE_SEGMENT_RE = /(?<!['"]Projects['"],\s*)['"`](?:session-manager|scheduled-plans|[\w.-]*-worktrees)['"`]/

// repo-relative path -> reason this file may join a home/tmp root with a scheduler-root segment.
const LIVE_ROOT_ALLOWLIST = new Map([
  ['scripts/__tests__/check-ops-path-literals.test.cjs', 'lint test: scratch fixtures deliberately contain violating lines'],
  // Non-scheduler app state that still lives under ~/.claude/session-manager (or a tmp worktree
  // root) with its own path; not yet routed through schedulerPaths. Migrating them is separate work.
  ['src/main/agentMemory.cjs', 'agent-memory dir: app state under ~/.claude/session-manager, not a scheduler root'],
  ['src/main/index.cjs', 'main-process log dir under ~/.claude/session-manager/logs, not a scheduler root'],
  ['src/main/layoutStore.cjs', 'workbench-layout.json: app state, not a scheduler root'],
  ['src/main/lib/credentials.cjs', 'credential-refresh log next to ~/.claude/.credentials.json, not a scheduler root'],
  ['src/main/lib/epicWorktreeProjectConfig.cjs', 'per-project epic-worktree config file under ~/.claude/session-manager; not a scheduler root'],
  ['src/main/lib/summarize.cjs', 'reads web-remote.json config; not a scheduler root'],
  ['src/main/seedAgentPersonas.cjs', 'seed marker file under ~/.claude/session-manager; not a scheduler root'],
  ['src/main/seedDevPlugin.cjs', 'seed marker file under ~/.claude/session-manager; not a scheduler root'],
  ['src/main/seedSchedulerMcp.cjs', 'seed marker file under ~/.claude/session-manager; not a scheduler root'],
  ['src/main/usage.cjs', 'billing-cache.json under ~/.claude/session-manager; not a scheduler root'],
  ['src/main/sessionsStore.cjs', 'tabs.json under ~/.claude/session-manager, plus its ~/.config/session-manager migration-source literal; not a scheduler root'],
  ['src/main/otelSettings.cjs', 'otel.json under ~/.claude/session-manager, plus its ~/.config/session-manager migration-source literal; not a scheduler root'],
  ['src/main/voiceSettings.cjs', 'voice.json under ~/.claude/session-manager, plus its ~/.config/session-manager migration-source literal; not a scheduler root'],
  ['src/main/lib/telemetrySettings.cjs', 'telemetry.json under ~/.claude/session-manager, plus its ~/.config/session-manager migration-source literal; not a scheduler root'],
  ['src/main/lib/telemetryBacklog.cjs', 'telemetry-watermarks.json under ~/.claude/session-manager, plus its ~/.config/session-manager migration-source literal; not a scheduler root'],
  ['src/main/lib/telemetryClient.cjs', 'telemetry spool under ~/.claude/session-manager, plus its ~/.config/session-manager migration-source literal; not a scheduler root'],
  // Tests that deliberately assert the default (unredirected) location.
  ['src/main/__tests__/heapSnapshot.test.cjs', 'asserts the default snapshot dir'],
  ['src/main/lib/__tests__/delegationReadiness.test.cjs', 'builds a fake job-worktree cwd string to classify; touches no disk'],
  ['src/main/lib/__tests__/schedulerPaths.test.cjs', 'asserts the resolver default location'],
  ['src/main/lib/__tests__/schedulerPathsWorktree.test.cjs', 'asserts the worktree-root default location'],
  ['src/main/lib/__tests__/sessionSlots.test.cjs', 'asserts the default slot-config location'],
  ['src/main/lib/__tests__/telemetryBacklog.test.cjs', 'builds a fake ephemeral worktree path string; touches no disk'],
  ['scripts/hooks/__tests__/guard-destructive-git.test.cjs', 'builds fake job/epic worktree cwd strings for the guard hook'],
  ['tests/e2e/scheduler-a11y.spec.ts', 'e2e drives the real app at its default scheduler root'],
  ['tests/e2e/scheduler-archive.spec.ts', 'e2e drives the real app at its default scheduler root'],
  ['tests/e2e/scheduler-needs-review.spec.ts', 'e2e drives the real app at its default scheduler root'],
  ['tests/e2e/scheduler-resilience.spec.ts', 'e2e drives the real app at its default scheduler root'],
])

function walk(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out)
    } else if (e.isFile() && FILE_RE.test(e.name)) out.push(full)
  }
}

// Returns [{ file (root-relative, posix), line, text }]. `allowlist` is overridable for tests.
function scan(root, { allowlist = ALLOWLIST } = {}) {
  const violations = []
  const files = []
  for (const d of SCAN_DIRS) walk(path.join(root, d), files)
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/')
    if (rel === RESOLVER_REL || rel === SELF_REL || allowlist.has(rel)) continue
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (LITERAL_RE.test(line)) violations.push({ file: rel, line: i + 1, text: line.trim().slice(0, 140) })
    })
  }
  return violations
}

function walkLive(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!LIVE_SKIP_DIRS.has(e.name)) walkLive(full, out)
    } else if (e.isFile() && LIVE_FILE_RE.test(e.name)) out.push(full)
  }
}

// LIVE_ROOT_LITERAL -> [{ file, line, text }]. `allowlist` is overridable for tests. O(total bytes).
function scanLiveRoots(root, { allowlist = LIVE_ROOT_ALLOWLIST } = {}) {
  const violations = []
  const files = []
  for (const d of LIVE_SCAN_DIRS) walkLive(path.join(root, d), files)
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/')
    if (rel === SCHEDULER_PATHS_REL || rel === SELF_REL || allowlist.has(rel)) continue
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      if (HOME_OR_TMP_RE.test(line) && LIVE_SEGMENT_RE.test(line)) {
        violations.push({ file: rel, line: i + 1, text: t.slice(0, 140) })
      }
    })
  }
  return violations
}

function main() {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
  const ops = scan(root)
  const live = scanLiveRoots(root)
  if (ops.length + live.length === 0) {
    console.log('check-ops-path-literals: clean')
    return
  }
  for (const v of ops) console.error(`${v.file}:${v.line}: ops-root literal outside ${RESOLVER_REL} — use opsPath(): ${v.text}`)
  for (const v of live) console.error(`${v.file}:${v.line}: LIVE_ROOT_LITERAL outside ${SCHEDULER_PATHS_REL} — use schedulerPaths: ${v.text}`)
  console.error(`check-ops-path-literals: ${ops.length + live.length} violation(s)`)
  process.exit(1)
}

if (require.main === module) main()
module.exports = { scan, scanLiveRoots, ALLOWLIST, LIVE_ROOT_ALLOWLIST }
