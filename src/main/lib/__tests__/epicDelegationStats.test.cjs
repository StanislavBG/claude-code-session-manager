/**
 * epicDelegationStats.test.cjs — unit tests for the derived-at-read-time
 * "did this Epic delegate?" counters (prdsQueued from the Epic's own live
 * PRD dir, inlineEdits from its interactive claude session transcript).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/epicDelegationStats.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  computeEpicDelegationStats,
  countPrdsQueued,
  countInlineEdits,
  isApplicationSourcePath,
} = require('../epicDelegationStats.cjs');
const { encodeCwd } = require('../encodeCwd.cjs');

const tmpDirs = [];
function makeTmpCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-delegation-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function makeTmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-delegation-home-'));
  tmpDirs.push(dir);
  return dir;
}

function writeTranscript(homeDir, cwd, sessionId, lines) {
  const dir = path.join(homeDir, '.claude', 'projects', encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

function toolUseLine(name, filePath) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, id: 't1', input: { file_path: filePath } }] },
  };
}

test('countPrdsQueued counts only .md files in the Epic own live prds dir', () => {
  const cwd = makeTmpCwd();
  const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'epic-1', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, '01-foo.md'), '# foo');
  fs.writeFileSync(path.join(prdsDir, '02-bar.md'), '# bar');
  fs.writeFileSync(path.join(prdsDir, '.reserved-03'), '');
  expect(countPrdsQueued(cwd, 'epic-1')).toBe(2);
});

test('countPrdsQueued returns 0 when the prds dir does not exist', () => {
  const cwd = makeTmpCwd();
  expect(countPrdsQueued(cwd, 'missing-epic')).toBe(0);
});

test('isApplicationSourcePath matches src/scripts/plugins/bin, rejects everything else', () => {
  const cwd = '/repo';
  expect(isApplicationSourcePath(cwd, '/repo/src/main/index.cjs')).toBe(true);
  expect(isApplicationSourcePath(cwd, '/repo/scripts/hooks/foo.cjs')).toBe(true);
  expect(isApplicationSourcePath(cwd, '/repo/plugins/dev/skill.md')).toBe(true);
  expect(isApplicationSourcePath(cwd, '/repo/bin/cli.cjs')).toBe(true);
  expect(isApplicationSourcePath(cwd, '/repo/session-manager-operations/scheduler/epics/e1/prds/01.md')).toBe(false);
  expect(isApplicationSourcePath(cwd, '/repo/README.md')).toBe(false);
  expect(isApplicationSourcePath(cwd, '/outside/src/index.cjs')).toBe(false);
  expect(isApplicationSourcePath(cwd, undefined)).toBe(false);
});

test('countInlineEdits counts Write/Edit/NotebookEdit tool_use blocks under application source only', () => {
  const cwd = makeTmpCwd();
  const homeDir = makeTmpHome();
  writeTranscript(homeDir, cwd, 'sess-1', [
    toolUseLine('Write', path.join(cwd, 'src', 'main', 'foo.cjs')),
    toolUseLine('Edit', path.join(cwd, 'src', 'main', 'foo.cjs')),
    toolUseLine('Read', path.join(cwd, 'src', 'main', 'foo.cjs')),
    toolUseLine('Write', path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'e1', 'prds', '01.md')),
    toolUseLine('NotebookEdit', path.join(cwd, 'scripts', 'nb.ipynb')),
  ]);
  expect(countInlineEdits(cwd, 'sess-1', { homeDir })).toBe(3);
});

test('countInlineEdits returns 0 when the transcript file does not exist', () => {
  const cwd = makeTmpCwd();
  const homeDir = makeTmpHome();
  expect(countInlineEdits(cwd, 'no-such-session', { homeDir })).toBe(0);
});

test('countInlineEdits returns 0 when claudeSessionId is missing', () => {
  const cwd = makeTmpCwd();
  expect(countInlineEdits(cwd, null)).toBe(0);
});

test('countInlineEdits tolerates a malformed trailing line', () => {
  const cwd = makeTmpCwd();
  const homeDir = makeTmpHome();
  const dir = path.join(homeDir, '.claude', 'projects', encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'sess-2.jsonl');
  fs.writeFileSync(
    filePath,
    JSON.stringify(toolUseLine('Write', path.join(cwd, 'src', 'a.ts'))) + '\n{not json\n',
  );
  expect(countInlineEdits(cwd, 'sess-2', { homeDir })).toBe(1);
});

test('computeEpicDelegationStats combines both counters and never throws on missing state', () => {
  const cwd = makeTmpCwd();
  const homeDir = makeTmpHome();
  expect(computeEpicDelegationStats(cwd, 'ghost-epic', 'ghost-session', { homeDir })).toEqual({
    prdsQueued: 0,
    inlineEdits: 0,
  });

  const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'epic-2', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, '01-foo.md'), '# foo');
  writeTranscript(homeDir, cwd, 'sess-3', [toolUseLine('Edit', path.join(cwd, 'src', 'x.ts'))]);
  expect(computeEpicDelegationStats(cwd, 'epic-2', 'sess-3', { homeDir })).toEqual({
    prdsQueued: 1,
    inlineEdits: 1,
  });
});
