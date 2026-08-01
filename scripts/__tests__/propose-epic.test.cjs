'use strict';

// Run: timeout 120 npx vitest run scripts/__tests__/propose-epic.test.cjs
//
// Provenance (PRD 905): propose-epic.cjs's ensureEpic call must pass
// source: { producer: 'propose-epic' } so a proposed Epic's active-index.json
// record traces back to the CLI that filed it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'propose-epic.cjs');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'propose-epic-test-'));
}

test('propose-epic.cjs stamps source: { producer: "propose-epic" } on the minted Epic', async () => {
  const cwd = makeTmpDir();
  try {
    const epicId = execFileSync('node', [SCRIPT, cwd, 'A proposed title', 'feature'], {
      input: 'the body\n',
      encoding: 'utf8',
    }).trim();

    const index = JSON.parse(fs.readFileSync(
      path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json'), 'utf8'));

    assert.ok(index.sessions[epicId], 'proposed Epic must be in active-index.json');
    assert.deepEqual(index.sessions[epicId].source, { producer: 'propose-epic' });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
