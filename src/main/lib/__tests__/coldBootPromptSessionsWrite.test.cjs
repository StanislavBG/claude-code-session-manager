/**
 * coldBootPromptSessionsWrite.test.cjs — regression coverage for the
 * "Epics marked Completed come back Open" bug.
 *
 * config.cjs's allowedRoots starts as just {os.homedir()}, and
 * validateWrite() explicitly skips the homedir root (a project cwd must be
 * registered via addAllowedRoot() before writeJson()/writeTextAtomic() will
 * accept a write under it). addAllowedRoot's only callers used to be pty.cjs
 * (Terminal spawn) and lib/prdCreate.cjs — never the Epic persistence path —
 * so on a cold boot, before any Terminal/PRD activity for a project, both
 * mergeActiveIndex's own write and the renderer's Epic-archive write
 * (config:write-json of promptSessionArchivePath) were silently rejected.
 *
 * Both cases below use a tmp dir INSIDE the homedir so validatePath (the
 * READ boundary, satisfied by the homedir root alone) succeeds while
 * validateWrite (which skips the homedir root, per config.cjs:113) still
 * requires an explicit per-project root registration — reproducing the
 * exact cold-boot gap without needing an out-of-home tmp root.
 *
 * Run: timeout 300 npx vitest run src/main/lib/__tests__/coldBootPromptSessionsWrite.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { mergeActiveIndex } = require('../activeIndexMerge.cjs');
const { readActiveIndex } = require('../epicMint.cjs');
const config = require('../../config.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkColdBootCwd(prefix) {
  // Deliberately under homedir (so validatePath's read boundary passes via
  // the default homedir root) and deliberately NOT registered via
  // config.addAllowedRoot() — simulates the exact state of allowedRoots
  // right after app boot, before any Terminal/PRD activity for this project.
  const cwd = await fsp.mkdtemp(path.join(os.homedir(), prefix));
  tmpDirs.push(cwd);
  return cwd;
}

function session(id, overrides = {}) {
  return {
    id,
    cwd: overrides.cwd || '/proj',
    goalText: overrides.goalText || `goal for ${id}`,
    claudeSessionId: overrides.claudeSessionId || `claude-${id}`,
    status: overrides.status || 'active',
    createdAt: overrides.createdAt || '2026-08-06T13:48:00.000Z',
    completedAt: overrides.completedAt ?? null,
  };
}

test('mergeActiveIndex writes active-index.json on a cold boot with only the homedir registered', async () => {
  const cwd = await mkColdBootCwd('.sm-test-activeindex-coldboot-');
  const s = session('psess-coldboot-1');

  await mergeActiveIndex(cwd, { sessions: { [s.id]: s }, events: {} });

  const index = readActiveIndex(cwd);
  expect(index.sessions[s.id]).toEqual(s);
});

// Mirrors what the 'config:write-json' IPC handler now does before calling
// writeJson (config.cjs's registerPromptSessionsRoot) — the main-process fix
// for state/promptSessions.ts's markCompleted -> writeJson(promptSessionArchivePath).
test('an Epic archive write succeeds on a cold boot with only the homedir registered', async () => {
  const cwd = await mkColdBootCwd('.sm-test-archive-coldboot-');
  const archivePath = path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'psess-archived-1.json');
  const archive = { ...session('psess-archived-1', { status: 'completed' }), completedAt: '2026-08-06T14:00:00.000Z' };

  config.registerPromptSessionsRoot(archivePath);
  await config.writeJson(archivePath, archive, { writer: 'epics' });

  const result = await config.readJson(archivePath);
  expect(result.exists).toBe(true);
  expect(result.data).toEqual(archive);
});
