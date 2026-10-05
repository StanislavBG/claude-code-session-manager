'use strict';
const fs = require('node:fs');
const path = require('node:path');
import { describe, it, expect } from 'vitest';

const src = fs.readFileSync(path.join(__dirname, '..', 'scheduler.cjs'), 'utf8');
const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('scheduler.cjs killTree adoption', () => {
  it('requires ./lib/killTree.cjs', () => {
    expect(src).toMatch(/require\('\.\/lib\/killTree\.cjs'\)/);
  });
  it('has no negative-pid process.kill call', () => {
    expect(code).not.toMatch(/process\.kill\(\s*-/);
  });
  it('spawns jobs with detachedSpawnOpts()', () => {
    expect(code).toMatch(/\.\.\.detachedSpawnOpts\(\)/);
  });
  it('skips /proc and ps identity checks on win32', () => {
    expect(code).toMatch(/process\.platform === 'win32'\) return 'unknown'/);
  });
});
