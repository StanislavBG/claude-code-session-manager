'use strict';
import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ensureGeminiSystemDefaults,
  realSystemDefaultsPath,
  OUTPUT_FILE,
} = require('../geminiContextDefaults.cjs');

let tmp;
let out;
let real;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-defaults-'));
  out = path.join(tmp, 'state');
  real = path.join(tmp, 'real-system-defaults.json');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function readOut() {
  return JSON.parse(fs.readFileSync(path.join(out, OUTPUT_FILE), 'utf8'));
}

function run(extra = {}) {
  return ensureGeminiSystemDefaults({
    env: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: real },
    platform: 'linux',
    fs,
    dir: out,
    ...extra,
  });
}

test('no real file: treated as {}, writes both names', () => {
  const r = run();
  expect(r).toEqual({ path: path.join(out, OUTPUT_FILE) });
  expect(readOut()).toEqual({ context: { fileName: ['AGENTS.md', 'GEMINI.md'] } });
});

test('real file with string fileName keeps it and other settings', () => {
  fs.writeFileSync(real, JSON.stringify({
    general: { vimMode: true },
    context: { fileName: 'CONTEXT.md', discoveryMaxDirs: 10 },
  }));
  run();
  expect(readOut()).toEqual({
    general: { vimMode: true },
    context: { fileName: ['CONTEXT.md', 'AGENTS.md', 'GEMINI.md'], discoveryMaxDirs: 10 },
  });
});

test('real file with array fileName merges without duplicates', () => {
  fs.writeFileSync(real, JSON.stringify({ context: { fileName: ['GEMINI.md', 'NOTES.md'] } }));
  run();
  expect(readOut().context.fileName).toEqual(['GEMINI.md', 'NOTES.md', 'AGENTS.md']);
});

test('env override path is the one read; platform defaults otherwise', () => {
  const other = path.join(tmp, 'other.json');
  fs.writeFileSync(other, JSON.stringify({ context: { fileName: 'X.md' } }));
  run({ env: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: other } });
  expect(readOut().context.fileName).toEqual(['X.md', 'AGENTS.md', 'GEMINI.md']);

  expect(realSystemDefaultsPath({ env: {}, platform: 'linux' })).toBe('/etc/gemini-cli/system-defaults.json');
  expect(realSystemDefaultsPath({ env: {}, platform: 'darwin' }))
    .toBe('/Library/Application Support/GeminiCli/system-defaults.json');
  expect(realSystemDefaultsPath({ env: {}, platform: 'win32' }))
    .toBe('C:\\ProgramData\\gemini-cli\\system-defaults.json');
  expect(realSystemDefaultsPath({ env: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: other }, platform: 'darwin' })).toBe(other);
});

test('malformed real file returns null and writes nothing', () => {
  fs.writeFileSync(real, '{ not json');
  expect(run()).toBeNull();
  expect(fs.existsSync(path.join(out, OUTPUT_FILE))).toBe(false);
});

test('non-object real file returns null', () => {
  fs.writeFileSync(real, '[1,2]');
  expect(run()).toBeNull();
  expect(fs.existsSync(path.join(out, OUTPUT_FILE))).toBe(false);
});

test('unreadable real file (read error other than ENOENT) returns null', () => {
  const fakeFs = {
    ...fs,
    readFileSync: (p, ...a) => {
      if (p === real) { const e = new Error('denied'); e.code = 'EACCES'; throw e; }
      return fs.readFileSync(p, ...a);
    },
  };
  expect(run({ fs: fakeFs })).toBeNull();
  expect(fs.existsSync(path.join(out, OUTPUT_FILE))).toBe(false);
});

test('unchanged content is not rewritten', () => {
  const r = run();
  const file = r.path;
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(file, past, past);
  const before = fs.statSync(file).mtimeMs;
  expect(run()).toEqual({ path: file });
  expect(fs.statSync(file).mtimeMs).toBe(before);

  fs.writeFileSync(real, JSON.stringify({ context: { fileName: 'NEW.md' } }));
  run();
  expect(fs.statSync(file).mtimeMs).not.toBe(before);
  expect(readOut().context.fileName).toEqual(['NEW.md', 'AGENTS.md', 'GEMINI.md']);
});
