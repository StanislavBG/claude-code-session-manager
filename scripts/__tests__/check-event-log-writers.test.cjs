/**
 * check-event-log-writers.test.cjs — a planted second writer of events.jsonl / the 'events'
 * ops namespace fails the lint with file:line; the writer itself, its tests, and the real
 * repo tree pass.
 *
 * Run: timeout 120 npx vitest run scripts/__tests__/check-event-log-writers.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../check-event-log-writers.cjs');
const REPO = path.resolve(__dirname, '../..');
const { scan } = require('../check-event-log-writers.cjs');

let root;
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const run = (dir = root) => spawnSync('node', [SCRIPT, dir], { encoding: 'utf8', timeout: 60000 });

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-log-lint-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('planted second writer (inline events.jsonl) fails naming file:line', () => {
  write('src/main/lib/rogue.cjs', "// c\nfs.appendFileSync(path.join(dir, 'events.jsonl'), line);\n");
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('src/main/lib/rogue.cjs:2');
});

test('planted writer via a variable bound to opsPath(..., "events", ...) fails', () => {
  write('scripts/rogue.cjs', [
    "const file = opsPath(cwd, 'events', id, 'log');",
    'const x = 1;',
    'await fsp.writeFile(file, body);',
    '',
  ].join('\n'));
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('scripts/rogue.cjs:3');
});

test('renderer and test files are scanned too', () => {
  write('src/renderer/x.ts', "fs.writeFileSync(opsPath(cwd, 'events', 'e', 'events.jsonl'), '')\n");
  write('src/main/__tests__/other.test.cjs', "fs.writeFileSync(path.join(d, 'events.jsonl'), '')\n");
  expect(scan(root).map((v) => v.file).sort()).toEqual(['src/main/__tests__/other.test.cjs', 'src/renderer/x.ts']);
});

test('writer, its tests, reads, and comments pass', () => {
  const W = "await fsp.appendFile(opsPath(cwd, 'events', id, 'events.jsonl'), line);\n";
  write('src/main/lib/epic/epicEventLog.cjs', W);
  write('src/main/lib/epic/__tests__/epicEventLog.test.cjs', W);
  write('src/main/lib/reader.cjs', "const raw = fs.readFileSync(opsPath(cwd, 'events', id, 'events.jsonl'), 'utf8');\n");
  write('src/main/lib/doc.cjs', "// fs.appendFile(path.join(d, 'events.jsonl'))\n");
  write('src/main/lib/other.cjs', "fs.writeFileSync(opsPath(cwd, 'epics', id, 'x.json'), body);\n");
  const r = run();
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
});

test('the real repo tree is clean (exit 0)', () => {
  const r = run(REPO);
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
});
