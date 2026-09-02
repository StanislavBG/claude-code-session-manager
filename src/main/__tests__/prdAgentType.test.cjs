/**
 * prdAgentType.test.cjs — the PRD `agentType` FK (lib/prdAgentType.cjs):
 * throw on write, report on read, mirroring agentModelResolve.cjs's/
 * epicMint.cjs's established convention for the Epic-level agentType FK.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdAgentType.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_PRD_AGENT_TYPE,
  assertAgentTypeWritable,
  reportDanglingAgentTypeOnce,
} = require('../lib/prdAgentType.cjs');
const { todayFile } = require('../lib/opsErrorLog.cjs');

async function mkTmpDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('DEFAULT_PRD_AGENT_TYPE is dev-lead', () => {
  expect(DEFAULT_PRD_AGENT_TYPE).toBe('dev-lead');
});

test('assertAgentTypeWritable is a no-op when agentType is omitted', async () => {
  await expect(assertAgentTypeWritable('/some/cwd', null)).resolves.toBeUndefined();
  await expect(assertAgentTypeWritable('/some/cwd', undefined)).resolves.toBeUndefined();
  await expect(assertAgentTypeWritable('/some/cwd', '')).resolves.toBeUndefined();
});

test('assertAgentTypeWritable resolves without throwing when a project-overlay persona file exists', async () => {
  const cwd = await mkTmpDir('sm-prd-agenttype-');
  try {
    const agentsDir = path.join(cwd, '.claude', 'agents');
    await fsp.mkdir(agentsDir, { recursive: true });
    await fsp.writeFile(path.join(agentsDir, 'my-persona.md'), '---\nname: my-persona\n---\nbody\n', 'utf8');
    await expect(assertAgentTypeWritable(cwd, 'my-persona')).resolves.toBeUndefined();
  } finally {
    await fsp.rm(cwd, { recursive: true, force: true });
  }
});

test('assertAgentTypeWritable rejects an unknown persona name, naming available personas in the error', async () => {
  const cwd = await mkTmpDir('sm-prd-agenttype-');
  try {
    await expect(
      assertAgentTypeWritable(cwd, 'zzz-definitely-not-a-real-persona-12345'),
    ).rejects.toThrow(/does not resolve to a readable persona file/);
    await expect(
      assertAgentTypeWritable(cwd, 'zzz-definitely-not-a-real-persona-12345'),
    ).rejects.toThrow(/Available personas/);
  } finally {
    await fsp.rm(cwd, { recursive: true, force: true });
  }
});

// READ side of the FK, mirroring agentModelResolve.test.cjs's sibling test
// for the Epic-level FK: verify against the REAL opsErrorLog write path
// (todayFile), not a mock — a plain mkdtemp() cwd is not "ephemeral"
// (ephemeralCwd.cjs only refuses os.tmpdir() itself / managed worktree
// roots), so appendError writes a real line here.
test('reportDanglingAgentTypeOnce logs once via opsErrorLog when the persona does not resolve, and never throws', async () => {
  const cwd = await mkTmpDir('sm-prd-agenttype-log-');
  try {
    expect(() => {
      reportDanglingAgentTypeOnce(cwd, 'ghost-persona-xyz', { personaExists: () => false });
      reportDanglingAgentTypeOnce(cwd, 'ghost-persona-xyz', { personaExists: () => false });
    }).not.toThrow();

    const lines = fs.readFileSync(todayFile(cwd), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const matches = lines.filter((l) => l.message.includes('ghost-persona-xyz'));
    // Logged once despite two calls above — dedup key is (cwd, agentType).
    expect(matches).toHaveLength(1);
    expect(matches[0].level).toBe('warn');
    expect(matches[0].scope).toBe('prdAgentType');
  } finally {
    await fsp.rm(cwd, { recursive: true, force: true });
  }
});

test('reportDanglingAgentTypeOnce is a no-op when the persona resolves', async () => {
  const cwd = await mkTmpDir('sm-prd-agenttype-log-');
  try {
    reportDanglingAgentTypeOnce(cwd, 'real-persona', { personaExists: () => true });
    expect(fs.existsSync(todayFile(cwd))).toBe(false);
  } finally {
    await fsp.rm(cwd, { recursive: true, force: true });
  }
});

test('reportDanglingAgentTypeOnce is a no-op when cwd or agentType is missing', () => {
  expect(() => {
    reportDanglingAgentTypeOnce(null, 'x', { personaExists: () => false });
    reportDanglingAgentTypeOnce('/some/cwd-missing-agenttype', null, { personaExists: () => false });
  }).not.toThrow();
});
