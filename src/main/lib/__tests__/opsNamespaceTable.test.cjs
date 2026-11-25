// The ops namespace table in session-manager-operations/AGENTS.md must agree
// with GIT_CLASS (opsOwnership.cjs): its Git column is how a reader learns
// which namespaces git ignores (PRD 4436 ignored projects' own feedback/).
// vitest globals (test) — same convention as the other .cjs tests.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { GIT_CLASS } = require('../opsOwnership.cjs');

const AGENTS_MD = path.join(__dirname, '../../../../session-manager-operations/AGENTS.md');

function cellsOf(line) {
  return line.split('|').map((s) => s.trim());
}

function readTable() {
  const lines = fs.readFileSync(AGENTS_MD, 'utf8').split('\n');
  const header = lines.find((l) => l.startsWith('| Namespace |'));
  assert.ok(header, 'namespace table header not found');
  const gitIdx = cellsOf(header).indexOf('Git');
  assert.ok(gitIdx > 0, 'namespace table has no Git column');
  const rows = new Map();
  for (const line of lines.filter((l) => l.startsWith('| `'))) {
    const cells = cellsOf(line);
    rows.set(cells[1].replace(/`/g, ''), cells[gitIdx]);
  }
  return rows;
}

test('every GIT_CLASS namespace has a row whose Git cell equals its class', () => {
  const rows = readTable();
  for (const [ns, cls] of Object.entries(GIT_CLASS)) {
    assert.ok(rows.has(ns), `no table row for ${ns}`);
    assert.equal(rows.get(ns), cls, `Git cell for ${ns}`);
  }
});

test('every runtime/tracked row names a GIT_CLASS key with that class', () => {
  for (const [ns, git] of readTable()) {
    if (git !== 'runtime' && git !== 'tracked') continue;
    assert.equal(GIT_CLASS[ns], git, `row ${ns} says ${git}`);
  }
});

test("the feedback row's Git cell is project's own", () => {
  assert.equal(readTable().get('feedback'), "project's own");
});
