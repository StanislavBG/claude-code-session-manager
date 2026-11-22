/**
 * installedPackagesMatch.test.cjs — the installed node_modules must satisfy package.json.
 *
 * Every job worktree links node_modules to the main checkout's folder. If that
 * folder lags package.json (zod 3.25.76 vs ^4.6.7, 2026-10-25..11-22), every gate
 * tests packages the release does not ship. This test fails, naming each package,
 * when a direct dependency is missing or does not satisfy its declared range.
 *
 * `semver` is not a direct dependency, so a small range check lives here. It reads
 * exact, caret, tilde and comparison (>=, >, <=, <, =) ranges, with npm's prerelease
 * rule; any other form (||, hyphen, x-ranges, tags, URLs) is reported as unreadable.
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/installedPackagesMatch.test.cjs
 */

'use strict';

import { test, expect, describe } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(str) {
  const m = VERSION_RE.exec(String(str).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

function comparePre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1; // release > prerelease
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      const d = Number(a[i]) - Number(b[i]);
      if (d) return Math.sign(d);
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

function compare(a, b) {
  return (
    Math.sign(a.major - b.major) ||
    Math.sign(a.minor - b.minor) ||
    Math.sign(a.patch - b.patch) ||
    comparePre(a.pre, b.pre)
  );
}

const sameTuple = (a, b) => a.major === b.major && a.minor === b.minor && a.patch === b.patch;

/** Range → { lower, upper, upperInclusive, lowerInclusive } or null when unreadable. */
function parseRange(range) {
  const r = String(range).trim();
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(r);
  if (!m) return null;
  const op = m[1] || '=';
  const v = parseVersion(m[2]);
  if (!v) return null;
  const base = { major: v.major, minor: v.minor, patch: v.patch, pre: [] };
  if (op === '=') return { anchor: v, lower: v, lowerInclusive: true, upper: v, upperInclusive: true };
  if (op === '>=') return { anchor: v, lower: v, lowerInclusive: true };
  if (op === '>') return { anchor: v, lower: v, lowerInclusive: false };
  if (op === '<=') return { anchor: v, upper: v, upperInclusive: true };
  if (op === '<') return { anchor: v, upper: v, upperInclusive: false };
  let upper;
  if (op === '~') upper = { ...base, minor: v.minor + 1, patch: 0 };
  else if (v.major > 0) upper = { ...base, major: v.major + 1, minor: 0, patch: 0 };
  else if (v.minor > 0) upper = { ...base, minor: v.minor + 1, patch: 0 };
  else upper = { ...base, patch: v.patch + 1 };
  // `<X.Y.Z` upper bounds exclude X.Y.Z-0 prereleases too (npm semantics).
  upper.pre = ['0'];
  return { anchor: v, lower: v, lowerInclusive: true, upper, upperInclusive: false };
}

/**
 * Pure check. Returns { ok: true } or { ok: false, reason } where reason is
 * 'missing', 'unreadable-range', 'unreadable-version' or 'out-of-range'.
 */
function checkInstalled(declaredRange, installedVersion) {
  const range = parseRange(declaredRange);
  if (!range) return { ok: false, reason: 'unreadable-range' };
  if (installedVersion == null) return { ok: false, reason: 'missing' };
  const v = parseVersion(installedVersion);
  if (!v) return { ok: false, reason: 'unreadable-version' };
  // npm: a prerelease only matches a range whose anchor is a prerelease of the same tuple.
  if (v.pre.length && !(range.anchor.pre.length && sameTuple(v, range.anchor))) {
    return { ok: false, reason: 'out-of-range' };
  }
  if (range.lower) {
    const c = compare(v, range.lower);
    if (c < 0 || (c === 0 && !range.lowerInclusive)) return { ok: false, reason: 'out-of-range' };
  }
  if (range.upper) {
    const c = compare(v, range.upper);
    if (c > 0 || (c === 0 && !range.upperInclusive)) return { ok: false, reason: 'out-of-range' };
  }
  return { ok: true };
}

function readInstalledVersion(root, name) {
  const p = path.join(root, 'node_modules', ...name.split('/'), 'package.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')).version ?? null;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function findMismatches(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const bad = [];
  for (const [name, range] of Object.entries(declared)) {
    const installed = readInstalledVersion(root, name);
    const res = checkInstalled(range, installed);
    if (!res.ok) bad.push({ name, range, installed: installed ?? 'missing', reason: res.reason });
  }
  return bad;
}

function formatMismatches(bad) {
  const lines = bad.map((b) =>
    b.reason === 'unreadable-range'
      ? `  ${b.name}: declared ${b.range} (range form this test cannot read), installed ${b.installed}`
      : `  ${b.name}: declared ${b.range}, installed ${b.installed}`,
  );
  return [
    `${bad.length} installed package(s) do not satisfy package.json:`,
    ...lines,
    'Fix: run npm install in the main checkout (job worktrees link its node_modules).',
  ].join('\n');
}

describe('checkInstalled (range check)', () => {
  test('3.25.76 against ^4.6.7 fails', () => {
    expect(checkInstalled('^4.6.7', '3.25.76')).toEqual({ ok: false, reason: 'out-of-range' });
  });
  test('4.6.7 against ^4.6.7 passes', () => {
    expect(checkInstalled('^4.6.7', '4.6.7')).toEqual({ ok: true });
  });
  test('42.11.10 against the exact 42.11.18 fails', () => {
    expect(checkInstalled('42.11.18', '42.11.10')).toEqual({ ok: false, reason: 'out-of-range' });
    expect(checkInstalled('42.11.18', '42.11.18')).toEqual({ ok: true });
  });
  test('a missing package fails', () => {
    expect(checkInstalled('^6.8.9', null)).toEqual({ ok: false, reason: 'missing' });
  });
  test('caret, tilde and 0.x bounds', () => {
    expect(checkInstalled('^4.6.7', '5.0.0').ok).toBe(false);
    expect(checkInstalled('^0.25.12', '0.25.99').ok).toBe(true);
    expect(checkInstalled('^0.25.12', '0.26.0').ok).toBe(false);
    expect(checkInstalled('^0.0.30', '0.0.31').ok).toBe(false);
    expect(checkInstalled('~1.2.3', '1.2.9').ok).toBe(true);
    expect(checkInstalled('~1.2.3', '1.3.0').ok).toBe(false);
  });
  test('prerelease rule', () => {
    expect(checkInstalled('^1.2.0-beta.12', '1.2.0-beta.13').ok).toBe(true);
    expect(checkInstalled('^1.2.0-beta.12', '1.2.0-beta.11').ok).toBe(false);
    expect(checkInstalled('^1.2.0-beta.12', '1.3.0').ok).toBe(true);
    expect(checkInstalled('^4.6.7', '4.7.0-rc.1').ok).toBe(false);
  });
  test('comparison forms', () => {
    expect(checkInstalled('>=2.0.0', '3.0.0').ok).toBe(true);
    expect(checkInstalled('>2.0.0', '2.0.0').ok).toBe(false);
    expect(checkInstalled('<2.0.0', '1.9.9').ok).toBe(true);
    expect(checkInstalled('<=2.0.0', '2.0.1').ok).toBe(false);
  });
  test('an unreadable range fails rather than passing', () => {
    for (const r of ['^1 || ^2', '1.x', 'latest', '1.0.0 - 2.0.0', 'github:a/b', '*']) {
      expect(checkInstalled(r, '1.0.0')).toEqual({ ok: false, reason: 'unreadable-range' });
    }
  });
  test('failure message names each package and ends with the fix', () => {
    const msg = formatMismatches([
      { name: 'zod', range: '^4.6.7', installed: '3.25.76', reason: 'out-of-range' },
      { name: 'electron-updater', range: '^6.8.9', installed: 'missing', reason: 'missing' },
    ]);
    expect(msg).toContain('zod: declared ^4.6.7, installed 3.25.76');
    expect(msg).toContain('electron-updater: declared ^6.8.9, installed missing');
    expect(msg.trimEnd().endsWith('Fix: run npm install in the main checkout (job worktrees link its node_modules).')).toBe(true);
  });
});

test('every direct dependency installed in node_modules satisfies package.json', () => {
  const bad = findMismatches(REPO_ROOT);
  if (bad.length) throw new Error(formatMismatches(bad));
  expect(bad).toEqual([]);
});
