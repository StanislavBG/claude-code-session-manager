/**
 * health-delegation-chain.test.cjs — "can this machine actually delegate
 * work to the scheduler?" health section (PRD 1049), built on top of the
 * delegation-readiness probe (delegationReadiness.cjs, PRD 1048). Exercises
 * evaluateDelegationChainHealth() directly since it's pure — no need to spawn
 * the full check() to cover shaping/degradation — plus one end-to-end check()
 * run against a fixture home seeded with the chain's user-scope state
 * (tests/helpers/delegationHome.cjs) plus this repo's tracked
 * .claude/settings.json guard wiring, where every check must pass.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/health-delegation-chain.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { evaluateDelegationChainHealth, check } = require('../health.cjs');
const { seedDelegationHome } = require('../../../tests/helpers/delegationHome.cjs');

function makeCheck(id, ok, overrides = {}) {
  return { id, label: `${id} label`, ok, detail: `${id} detail`, fix: ok ? null : `fix ${id}`, ...overrides };
}

test('all checks passing -> component ok, no issues', () => {
  const delegationResult = {
    ok: true,
    checks: [
      makeCheck('scheduler-mcp', true),
      makeCheck('scheduler-mcp-live', true),
      makeCheck('scheduler-mcp-project-duplicate', true, { warn: false }),
      makeCheck('dev-plugin', true),
      makeCheck('agent-personas', true),
      makeCheck('prd-write-guard', true),
    ],
  };
  const { component, issues } = evaluateDelegationChainHealth(delegationResult);
  expect(component.ok).toBe(true);
  expect(component.checks).toHaveLength(6);
  expect(issues).toEqual([]);
});

test('one failing check -> component not ok, one issue citing label/detail/fix', () => {
  const delegationResult = {
    ok: false,
    checks: [
      makeCheck('scheduler-mcp', false, { label: 'Scheduler MCP server registered', detail: 'no entry found', fix: 'claude mcp add ...' }),
      makeCheck('scheduler-mcp-live', true, { skipped: true }),
      makeCheck('scheduler-mcp-project-duplicate', true, { warn: false }),
      makeCheck('dev-plugin', true),
      makeCheck('agent-personas', true),
      makeCheck('prd-write-guard', true),
    ],
  };
  const { component, issues } = evaluateDelegationChainHealth(delegationResult);
  expect(component.ok).toBe(false);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toContain('Scheduler MCP server registered');
  expect(issues[0]).toContain('no entry found');
  expect(issues[0]).toContain('claude mcp add ...');
});

test('multiple failing checks -> one issue per failing check, passing checks silent', () => {
  const delegationResult = {
    ok: false,
    checks: [
      makeCheck('scheduler-mcp', false),
      makeCheck('scheduler-mcp-live', false),
      makeCheck('scheduler-mcp-project-duplicate', true, { warn: false }),
      makeCheck('dev-plugin', false),
      makeCheck('agent-personas', true),
      makeCheck('prd-write-guard', true),
    ],
  };
  const { issues } = evaluateDelegationChainHealth(delegationResult);
  expect(issues).toHaveLength(3);
});

test('failing check with no fix omits the "(fix: ...)" suffix', () => {
  const delegationResult = {
    ok: false,
    checks: [makeCheck('scheduler-mcp', false, { fix: null })],
  };
  const { issues } = evaluateDelegationChainHealth(delegationResult);
  expect(issues[0]).not.toContain('(fix:');
});

test('end-to-end: check() reports delegation_chain ok with the chain installed in a fixture home', async () => {
  // HOME points at a temp home seeded with the user-scope state; the real home is never read.
  // Assigning HOME drops the sandbox SM_SCHEDULER_HOME override, so it is re-pinned.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const sandboxHome = process.env.HOME;
  const sandboxSchedulerHome = process.env.SM_SCHEDULER_HOME;
  const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-health-delegation-home-'));
  let status;
  try {
    await seedDelegationHome(fixtureHome);
    process.env.HOME = fixtureHome;
    if (sandboxSchedulerHome !== undefined) process.env.SM_SCHEDULER_HOME = sandboxSchedulerHome;
    // skipTypecheck: this test asserts on delegation_chain only; the tsc shell-out was
    // ~15s of the ~16s idle runtime and starved to the 90s budget under CPU load.
    status = await check({ skipTypecheck: true });
  } finally {
    process.env.HOME = sandboxHome;
    fs.rmSync(fixtureHome, { recursive: true, force: true });
  }
  expect(status.components.delegation_chain).toBeDefined();
  expect(status.components.delegation_chain.checks).toHaveLength(9);
  const ids = status.components.delegation_chain.checks.map((c) => c.id);
  expect(ids).toEqual([
    'scheduler-mcp',
    'scheduler-mcp-live',
    'scheduler-mcp-project-duplicate',
    'dev-plugin',
    'agent-personas',
    'prd-write-guard',
    'destructive-git-guard',
    'inline-implementation-guard',
    'self-schedule-guard',
  ]);
  const checks = status.components.delegation_chain.checks;
  expect(checks.filter((c) => !c.ok).map((c) => c.id)).toEqual([]);
  expect(status.components.delegation_chain.ok).toBe(true);
}, 90_000);
