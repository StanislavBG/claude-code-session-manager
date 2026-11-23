/**
 * check-doc-hierarchy.test.cjs — the doc-hierarchy linter fails on each defect
 * class and passes on a clean scratch tree.
 *
 * Run: timeout 300 npx vitest run scripts/__tests__/check-doc-hierarchy.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../check-doc-hierarchy.cjs');
const OPS = 'session-manager-operations';
const FILES = [
  'README.md', 'src/CLAUDE.md', 'src/renderer/CLAUDE.md', 'scripts/README.md', 'tests/README.md',
  'web/README.md', 'web/remote-app/CLAUDE.md', 'web-remote/CLAUDE.md', 'plugins/CLAUDE.md',
  `${OPS}/CLAUDE.md`, `${OPS}/architecture/README.md`, `${OPS}/scheduler/README.md`,
];

let root;
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const run = () => spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-hier-'));
  for (const f of FILES) write(f, '# doc\n');
  write('.session-manager.json', JSON.stringify({ mdNetwork: { history: [] } }));
  write('CLAUDE.md', '> **SIZE BUDGET — 12,000 chars**\n\n## Scoped MDs\n\n| Path | Scope |\n| --- | --- |\n| [`src/CLAUDE.md`](src/CLAUDE.md) | main |\n' + FILES.filter((f) => f !== 'src/CLAUDE.md').map((f) => `[${f}](${f})\n`).join(''));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('clean scratch tree passes', () => {
  const r = run();
  expect(r.status, r.stderr).toBe(0);
});

test('missing junction file fails', () => {
  fs.rmSync(path.join(root, 'tests/README.md'));
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('missing junction: tests/README.md');
});

test('oversized nested CLAUDE.md fails', () => {
  write('src/CLAUDE.md', 'x'.repeat(4001));
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('src/CLAUDE.md is 4001 bytes');
});

test('broken relative link fails', () => {
  write('web/README.md', 'see [gone](./nope.md#top)\n');
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('web/README.md: broken relative link: ./nope.md#top');
});

test('link to a gitignored, absent path is a note; a non-ignored missing path still fails', () => {
  spawnSync('git', ['init', '-q'], { cwd: root });
  write('.gitignore', 'web/built-output/\n');
  write('web/README.md', 'see [out](./built-output/index.html)\n');
  let r = run();
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain('note:');
  expect(r.stdout).toContain('./built-output/index.html');
  write('web/README.md', 'see [out](./built-output/index.html) and [gone](./nope/x.md)\n');
  r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('broken relative link: ./nope/x.md');
  expect(r.stderr).not.toContain('built-output');
});

test('file:// link fails', () => {
  write('plugins/CLAUDE.md', '[abs](file:///home/x/y.md)\n');
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('plugins/CLAUDE.md: file:// link');
});

test('reachable nested markdown passes; orphan fails; exempt-prefix orphan passes', () => {
  write('docs/extra.md', '# extra\n');
  let r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('docs/extra.md: orphan markdown');
  write('web/README.md', 'see [extra](../docs/extra.md#top)\n');
  r = run();
  expect(r.status, r.stderr).toBe(0);
  write('src/seed/x.md', '# seeded\n');
  r = run();
  expect(r.status, r.stderr).toBe(0);
});

// AGENTS.md as the entry map: CLAUDE.md becomes a one-line @AGENTS.md stub.
const rootMap = (budget) => fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8').replace('12,000', budget);
const moveMapToAgents = (budget = '12,000') => {
  write('AGENTS.md', rootMap(budget));
  write('CLAUDE.md', '@AGENTS.md\n');
};

test('map choice: with root AGENTS.md, the Scoped MDs table is read from AGENTS.md', () => {
  moveMapToAgents();
  let r = run();
  expect(r.status, r.stderr).toBe(0);
  write('AGENTS.md', fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8').replace('| [`src/CLAUDE.md`](src/CLAUDE.md) | main |', '| `src/gone/CLAUDE.md` | main |'));
  r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('AGENTS.md: scoped-MD row does not resolve: src/gone/CLAUDE.md');
  write('AGENTS.md', '# map without a table\n');
  r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('AGENTS.md: no "Scoped MDs" table found');
});

test('map choice: without AGENTS.md, a CLAUDE.md lacking the table still fails as before', () => {
  write('CLAUDE.md', '# no table\n');
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('CLAUDE.md: no "Scoped MDs" table found');
});

test('root pair budget: budget from AGENTS.md, CLAUDE.md + AGENTS.md bytes counted together', () => {
  const size = Buffer.byteLength(rootMap('12,000'));
  // Budget equal to AGENTS.md alone: the stub's bytes push the pair over.
  moveMapToAgents(String(size));
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('CLAUDE.md + AGENTS.md is');
});

test('nested pair: CLAUDE.md + AGENTS.md bytes in one folder share the 4000-byte limit', () => {
  write('src/AGENTS.md', 'x'.repeat(3000));
  write('src/CLAUDE.md', '@AGENTS.md\n' + 'y'.repeat(1000));
  let r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('src/CLAUDE.md + src/AGENTS.md is 4011 bytes');
  write('src/CLAUDE.md', '@AGENTS.md\n');
  r = run();
  expect(r.status, r.stderr).toBe(0);
  write('web/AGENTS.md', 'z'.repeat(4001));
  r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('web/AGENTS.md is 4001 bytes');
});

test('stub rule: a CLAUDE.md beside an AGENTS.md must start with @AGENTS.md', () => {
  write('plugins/AGENTS.md', '# plugins map\n');
  let r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('plugins/CLAUDE.md: has an AGENTS.md beside it, so its first non-blank line must be @AGENTS.md');
  write('plugins/CLAUDE.md', '\n\n@AGENTS.md\n\nextra Claude-only note\n');
  r = run();
  expect(r.status, r.stderr).toBe(0);
  write('AGENTS.md', fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'));
  r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('CLAUDE.md: has an AGENTS.md beside it');
});

test('junction: an AGENTS.md beside a listed CLAUDE.md junction satisfies it', () => {
  fs.rmSync(path.join(root, 'web-remote/CLAUDE.md'));
  write('web-remote/AGENTS.md', '# relay\n');
  write('CLAUDE.md', fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8').replace(/web-remote\/CLAUDE\.md/g, 'web-remote/AGENTS.md'));
  const r = run();
  expect(r.status, r.stderr).toBe(0);
});

test('reachability starts from both root files: linked only from AGENTS.md is not an orphan', () => {
  moveMapToAgents();
  write('docs/only-agents.md', '# x\n');
  let r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('docs/only-agents.md: orphan markdown');
  write('AGENTS.md', fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8') + '[x](docs/only-agents.md)\n');
  r = run();
  expect(r.status, r.stderr).toBe(0);
});

test('history prefixes come from .session-manager.json mdNetwork.history', () => {
  write('old/notes/x.md', '# historical\n');
  let r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('old/notes/x.md: orphan markdown');
  write('.session-manager.json', JSON.stringify({ mdNetwork: { history: ['old/'] } }));
  r = run();
  expect(r.status, r.stderr).toBe(0);
});

test('missing .session-manager.json fails with one diagnostic line', () => {
  fs.rmSync(path.join(root, '.session-manager.json'));
  const r = run();
  expect(r.status).toBe(1);
  const lines = r.stderr.trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('.session-manager.json');
  expect(lines[0]).toContain('mdNetwork.history');
});

test('invalid .session-manager.json fails with one diagnostic line', () => {
  write('.session-manager.json', '{ not json');
  let r = run();
  expect(r.status).toBe(1);
  expect(r.stderr.trim().split('\n')).toHaveLength(1);
  expect(r.stderr).toContain('.session-manager.json');
  write('.session-manager.json', JSON.stringify({ mdNetwork: { history: 'old/' } }));
  r = run();
  expect(r.status).toBe(1);
  expect(r.stderr.trim().split('\n')).toHaveLength(1);
  expect(r.stderr).toContain('mdNetwork.history');
});

// Model-mitigations registry: each row's needle must still be quoted verbatim at its location.
const MM = `${OPS}/architecture/model-mitigations.md`;
const mmDoc = (rows) => '# Model mitigations\n\n| id | behavior | model | observed | location | needle |\n| --- | --- | --- | --- | --- | --- |\n' +
  rows.map((r) => `| ${r.id} | b | m | 2026-11-23 | \`${r.location}\` | \`${r.needle}\` |\n`).join('');
const withRegistry = (rows) => {
  write(`${OPS}/architecture/README.md`, '# doc\n\n[mm](model-mitigations.md)\n');
  write(MM, mmDoc(rows));
};

test('model mitigations: a row whose needle is present passes', () => {
  write('src/seed/agents/x.md', 'Never start background work, ever.\n');
  withRegistry([{ id: 'MM-1', location: 'src/seed/agents/x.md', needle: 'Never start background work' }]);
  const r = run();
  expect(r.status, r.stderr).toBe(0);
});

test('model mitigations: a stale row (needle gone) fails naming the row id', () => {
  write('src/seed/agents/x.md', 'This rule was rewritten.\n');
  withRegistry([{ id: 'MM-7', location: 'src/seed/agents/x.md', needle: 'Never start background work' }]);
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain(`${MM}: MM-7: needle not found in src/seed/agents/x.md`);
});

test('model mitigations: a row whose location file is missing fails naming the row id', () => {
  withRegistry([{ id: 'MM-3', location: 'src/seed/agents/gone.md', needle: 'anything' }]);
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain(`${MM}: MM-3: location file missing: src/seed/agents/gone.md`);
});

test('model mitigations: a registry with no rows fails', () => {
  withRegistry([]);
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain(`${MM}: no mitigation rows found`);
});
