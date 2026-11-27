// Guards the intraday webhook tick: every scheduler.<name>( call in index.cjs
// must resolve to a real export, or the tick throws a synchronous TypeError.
import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const scheduler = require('../scheduler.cjs');

test('scheduler exports readQueue', () => {
  expect(typeof scheduler.readQueue).toBe('function');
});

test('every scheduler.<name>( called in index.cjs is exported', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.cjs'), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/\bscheduler\.([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  const exported = new Set(Object.keys(scheduler));
  const missing = [...names].filter((n) => !exported.has(n)).sort();
  expect(missing).toEqual([]);
});
