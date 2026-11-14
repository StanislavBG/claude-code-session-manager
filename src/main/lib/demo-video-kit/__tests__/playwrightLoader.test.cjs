'use strict';
import { describe, it, expect } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPlaywright } = require('../playwrightLoader.cjs');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function fakeNpx(home, hash, marker, mtimeS) {
  const dir = path.join(home, '.npm', '_npx', hash, 'node_modules', 'playwright');
  fs.mkdirSync(dir, { recursive: true });
  const pkg = path.join(dir, 'package.json');
  fs.writeFileSync(pkg, JSON.stringify({ name: 'playwright', version: '0.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = { marker: ${JSON.stringify(marker)}, chromium: {} };\n`);
  fs.utimesSync(pkg, mtimeS, mtimeS);
}

describe('loadPlaywright', () => {
  it('finds playwright in the npx cache when cwd and npmRoot have none', () => {
    const home = tmp('pwl-home-');
    fakeNpx(home, 'aaa111', 'npx-only', 1_700_000_000);
    const pw = loadPlaywright({ home, cwd: tmp('pwl-cwd-'), npmRoot: tmp('pwl-root-') });
    expect(pw && pw.marker).toBe('npx-only');
  });
  it('prefers the copy with the newest package.json mtime', () => {
    const home = tmp('pwl-home-');
    fakeNpx(home, 'old000', 'old', 1_600_000_000);
    fakeNpx(home, 'new999', 'new', 1_800_000_000);
    fakeNpx(home, 'mid555', 'mid', 1_700_000_000);
    const pw = loadPlaywright({ home, cwd: tmp('pwl-cwd-'), npmRoot: tmp('pwl-root-') });
    expect(pw && pw.marker).toBe('new');
  });
  it('returns null for an empty home without throwing', () => {
    expect(loadPlaywright({ home: tmp('pwl-home-'), cwd: tmp('pwl-cwd-'), npmRoot: tmp('pwl-root-') })).toBeNull();
  });
  it('returns null when home does not exist', () => {
    expect(loadPlaywright({ home: path.join(tmp('pwl-x-'), 'missing'), cwd: tmp('pwl-cwd-'), npmRoot: '' })).toBeNull();
  });
});
