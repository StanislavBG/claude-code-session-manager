'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
import { describe, it, expect } from 'vitest';

const { scanTestSource, scanRepo, sharedModulesOf } = require('../smells.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

const FIXTURES = {
  'src/main/__tests__/clean.test.cjs': {
    smells: [],
    text: [
      "const lib = require('../lib/shared.cjs');",
      "import { describe, it, expect } from 'vitest';",
      "describe('clean', () => {",
      "  it('a', () => { expect(lib.add(1, 2)).toBe(3); });",
      "  it('b', () => { expect(lib.add(2, 2)).toBe(4); });",
      "  it('c', () => { expect(lib.add(3, 2)).toBe(5); });",
      '});',
      '',
    ].join('\n'),
  },
  'src/main/__tests__/source-text.test.cjs': {
    smells: ['source-text'],
    text: [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "import { describe, it, expect } from 'vitest';",
      "const src = fs.readFileSync(path.join(__dirname, '..', 'thing.cjs'), 'utf8');",
      "describe('thing', () => {",
      "  it('a', () => { expect(src).toMatch(/foo/); });",
      "  it('b', () => { expect(src.includes('bar')).toBe(true); });",
      "  it('c', () => { expect(src.length).toBeGreaterThan(0); });",
      '});',
      '',
    ].join('\n'),
  },
  'src/main/__tests__/no-assert.test.cjs': {
    smells: ['no-assert'],
    text: [
      "import { describe, it, expect } from 'vitest';",
      "describe('x', () => {",
      "  it('a', () => { expect(1).toBe(1); });",
      "  it('b', () => { const v = 1 + 1; void v; });",
      "  it('c', () => { expect(2).toBe(2); });",
      '});',
      '',
    ].join('\n'),
  },
  'src/main/__tests__/mock-only.test.cjs': {
    smells: ['mock-only'],
    text: [
      "import { describe, it, expect, vi } from 'vitest';",
      "describe('x', () => {",
      "  it('a', () => { const f = vi.fn(); f(1); expect(f).toHaveBeenCalledWith(1); });",
      "  it('b', () => { const f = vi.fn(); f(); expect(f).toHaveBeenCalled(); });",
      "  it('c', () => { expect(1).toBe(1); });",
      '});',
      '',
    ].join('\n'),
  },
  'src/main/__tests__/micro.test.cjs': {
    smells: ['micro-file'],
    text: [
      "const lib = require('../lib/shared.cjs');",
      "import { it, expect } from 'vitest';",
      "it('adds', () => { expect(lib.add(1, 1)).toBe(2); });",
      '',
    ].join('\n'),
  },
  'src/main/__tests__/prd123-thing.test.cjs': {
    smells: ['prd-named'],
    text: [
      "import { describe, it, expect } from 'vitest';",
      "describe('x', () => {",
      "  it('a', () => { expect(1).toBe(1); });",
      "  it('b', () => { expect(2).toBe(2); });",
      "  it('c', () => { expect(3).toBe(3); });",
      '});',
      '',
    ].join('\n'),
  },
};

describe('smells scanner', () => {
  it('tags a fixture tree with exactly the expected smells per file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smells-'));
    try {
      const entries = [];
      for (const [rel, { text }] of Object.entries(FIXTURES)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text);
        entries.push({ relPath: rel, text: fs.readFileSync(abs, 'utf8') });
      }
      const shared = sharedModulesOf(entries);
      for (const { relPath, text } of entries) {
        const res = scanTestSource(relPath, text, shared);
        expect({ file: relPath, smells: res.smells }).toEqual({ file: relPath, smells: FIXTURES[relPath].smells });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('scans the real repo and separates source-text tests from behavioural ones', () => {
    const { files, totals } = scanRepo(REPO_ROOT);
    expect(files.length).toBeGreaterThanOrEqual(600);
    expect(totals.files).toBe(files.length);
    const by = Object.fromEntries(files.map((f) => [f.file, f]));
    expect(by['src/main/__tests__/scheduler-killtree-adoption.test.cjs'].smells).toContain('source-text');
    expect(by['src/main/lib/util/__tests__/atomicFs.test.cjs'].smells).not.toContain('source-text');
  });

  it('--check fails on new offenders and stale entries, passes when clean', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smells-check-'));
    try {
      for (const rel of ['src/main/__tests__/source-text.test.cjs', 'src/main/__tests__/clean.test.cjs']) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, FIXTURES[rel].text);
      }
      const run = (allowlist) => {
        fs.writeFileSync(path.join(root, 'allow.json'), JSON.stringify(allowlist));
        return spawnSync(process.execPath, [path.join(__dirname, '..', 'smells.cjs'), '--check', 'allow.json', '--root', root], { encoding: 'utf8' });
      };
      const fresh = run({ 'source-text': [], 'no-assert': [] });
      expect(fresh.status).toBe(1);
      expect(fresh.stderr).toContain('src/main/__tests__/source-text.test.cjs: new source-text');

      const stale = run({ 'source-text': ['src/main/__tests__/source-text.test.cjs'], 'no-assert': ['src/main/__tests__/clean.test.cjs', 'src/main/__tests__/gone.test.cjs'] });
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain('clean.test.cjs: allowlisted for no-assert but no longer has it — remove it from the allowlist');
      expect(stale.stderr).toContain('gone.test.cjs: allowlisted for no-assert but the file no longer exists — remove it from the allowlist');

      const clean = run({ 'source-text': ['src/main/__tests__/source-text.test.cjs'], 'no-assert': [] });
      expect(clean.status).toBe(0);
      expect(clean.stdout).toContain('OK');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
