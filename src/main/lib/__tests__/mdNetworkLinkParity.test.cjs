/**
 * mdNetworkLinkParity.test.cjs — the app's link map (mdNetworkScan.cjs) and the skill's
 * dependency-free drift-check.cjs `orphans` check must agree on what a link is: same
 * fixture repo, same orphan path set.
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/mdNetworkLinkParity.test.cjs
 */

'use strict';

import { describe, test, expect, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scanMdNetwork } = require('../mdNetworkScan.cjs');
const { runDriftCheck } = require('../../../../plugins/session-manager-dev/skills/maintaining-md-network/scripts/drift-check.cjs');

const dirs = [];
afterAll(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdnet-parity-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  for (const args of [['init', '-q'], ['add', '-A']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return dir;
}

async function scannerOrphans(dir) {
  const res = await scanMdNetwork(dir);
  if (!res.ok) throw new Error(res.error);
  return res.findings.filter((f) => f.type === 'orphan').flatMap((f) => f.paths).sort();
}

function driftOrphans(dir) {
  return runDriftCheck({ root: dir, checks: ['orphans'] })
    .findings.filter((f) => f.kind === 'orphan')
    .map((f) => f.file)
    .sort();
}

const FIXTURES = {
  'backticked map': {
    files: {
      'CLAUDE.md': '# Map\n\n| Doc | Covers |\n| --- | --- |\n| `docs/a.md` | A |\n| `docs/sub/b.md` | B |\n',
      'docs/a.md': '# A\nSee [c](c.md).\n',
      'docs/c.md': '# C\n',
      'docs/sub/b.md': '# B\nRoot form `docs/sub/d.md`, doc-relative `e/f.md`.\n',
      'docs/sub/d.md': '# D\n',
      'docs/sub/e/f.md': '# F\n',
    },
    expected: [],
  },
  '@-imported map': {
    files: {
      'CLAUDE.md': '@docs/map.md\n',
      'docs/map.md': '# Map\n- <guide.md>\n- @rules/r.md\n',
      'docs/guide.md': '# G\n',
      'docs/rules/r.md': '# R\n',
    },
    expected: [],
  },
  'mixed: one true orphan, one dead backticked path': {
    files: {
      'CLAUDE.md': [
        '# Map',
        '- [guide](docs/guide.md)',
        '- `docs/gone.md` (dead backticked path: no edge, no finding)',
        '- @docs/imported.md',
        '<!-- [hidden](docs/hidden.md) -->',
        '```',
        '[fenced](docs/fenced.md)',
        '```',
        '',
      ].join('\n'),
      'docs/guide.md': '# Guide\nNext: `docs/deep/leaf.md`\n',
      'docs/imported.md': '# Imported\n',
      'docs/deep/leaf.md': '# Leaf\n',
      'docs/hidden.md': '# Hidden\n',
      'docs/fenced.md': '# Fenced\n',
      'notes/lonely.md': '# Lonely, linked from nowhere\n',
    },
    expected: ['docs/fenced.md', 'docs/hidden.md', 'notes/lonely.md'],
  },
};

describe('mdNetworkScan and drift-check orphans agree', () => {
  for (const [name, { files, expected }] of Object.entries(FIXTURES)) {
    test(name, async () => {
      const dir = repo(files);
      const fromScanner = await scannerOrphans(dir);
      expect(driftOrphans(dir)).toEqual(fromScanner);
      expect(fromScanner).toEqual(expected);
    });
  }
});
