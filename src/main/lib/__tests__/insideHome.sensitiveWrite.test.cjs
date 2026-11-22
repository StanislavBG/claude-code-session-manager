'use strict';

// assertNotSensitiveWrite — the single write-side denylist shared by files:*
// mutations and config writes. Explicit `home` so the test is host-independent.

import { test } from 'vitest';
const assert = require('node:assert/strict');
const path = require('node:path');

const { assertNotSensitiveWrite } = require('../insideHome.cjs');

const home = path.join(path.sep, 'home', 'tester');
const under = (...p) => path.join(home, ...p);

test('refuses .credentials.json anywhere', () => {
  assert.throws(() => assertNotSensitiveWrite(under('.claude', '.credentials.json'), home), { message: 'Write to .credentials.json denied' });
  assert.throws(() => assertNotSensitiveWrite(under('Projects', 'x', '.credentials.json'), home), { message: 'Write to .credentials.json denied' });
});

test('refuses ~/.ssh itself and anything below it', () => {
  assert.throws(() => assertNotSensitiveWrite(under('.ssh'), home), { message: 'Write inside ~/.ssh denied' });
  assert.throws(() => assertNotSensitiveWrite(under('.ssh', 'authorized_keys'), home), { message: 'Write inside ~/.ssh denied' });
  assert.throws(() => assertNotSensitiveWrite(under('.ssh', 'keys', 'id'), home), { message: 'Write inside ~/.ssh denied' });
});

test('refuses entries below ~/.config/autostart', () => {
  assert.throws(() => assertNotSensitiveWrite(under('.config', 'autostart', 'evil.desktop'), home), { message: 'Write to ~/.config/autostart denied' });
});

test('allows ordinary paths and returns undefined', () => {
  for (const p of [under('Projects', 'x', 'CLAUDE.md'), under('.bashrc'), under('.sshfoo', 'x')]) {
    assert.equal(assertNotSensitiveWrite(p, home), undefined, `${p} should be allowed`);
  }
});
