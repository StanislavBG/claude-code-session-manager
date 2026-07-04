'use strict';

// rejectCredentials — write-side denylist for files:* mutations (write/create/
// rename/delete all call it). Pure path logic; no fs touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { rejectCredentials } = require('../files.cjs');

const home = os.homedir();
const under = (...p) => path.join(home, ...p);

test('denies writing the OAuth credentials file', () => {
  assert.throws(() => rejectCredentials(under('.claude', '.credentials.json')), /credentials\.json denied/);
});

test('denies writes anywhere inside ~/.ssh (keys, authorized_keys, config)', () => {
  for (const p of ['authorized_keys', 'authorized_keys2', 'id_ed25519', 'config']) {
    assert.throws(() => rejectCredentials(under('.ssh', p)), /\.ssh denied/, `~/.ssh/${p} should be denied`);
  }
  assert.throws(() => rejectCredentials(under('.ssh')), /\.ssh denied/);
});

test('denies writing autostart persistence entries', () => {
  assert.throws(() => rejectCredentials(under('.config', 'autostart', 'evil.desktop')), /autostart denied/);
});

test('allows ordinary files — including shell rc, which developers do edit', () => {
  for (const p of [under('Projects', 'app', 'src', 'index.ts'), under('.bashrc'), under('.zshrc'), under('.config', 'session-manager', 'voice.json')]) {
    assert.doesNotThrow(() => rejectCredentials(p), `${p} should be allowed`);
  }
});

test('a path that merely starts with ".ssh" but is a sibling is not over-blocked', () => {
  // ~/.sshfoo is a different entry — must NOT be caught by the ~/.ssh rule.
  assert.doesNotThrow(() => rejectCredentials(under('.sshfoo', 'x')));
});
