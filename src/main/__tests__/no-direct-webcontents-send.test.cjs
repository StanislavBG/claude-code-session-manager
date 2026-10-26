/**
 * Guard: every renderer push must go through lib/sendToRenderer.cjs's sendIfAlive so the
 * remote fanout sees it. Fails on any direct `webContents.send(` in src/main.
 */
'use strict';
import { describe, it, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');

const MAIN = path.resolve(__dirname, '..');
const ALLOWED = path.join(MAIN, 'lib', 'sendToRenderer.cjs');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      walk(p, out);
    } else if (/\.(cjs|js|mjs|ts)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

describe('no direct webContents.send', () => {
  it('only lib/sendToRenderer.cjs calls webContents.send(', () => {
    const offenders = walk(MAIN, [])
      .filter((f) => f !== ALLOWED)
      .filter((f) => fs.readFileSync(f, 'utf8').includes('webContents.send('))
      .map((f) => path.relative(MAIN, f));
    expect(offenders).toEqual([]);
  });
});
