/**
 * health-delegation-chain.test.cjs — "can this machine actually delegate
 * work to the scheduler?" health section (PRD 1049), built on top of the
 * delegation-readiness probe (delegationReadiness.cjs, PRD 1048). Exercises
 * evaluateDelegationChainHealth() directly since it's pure — no need to spawn
 * the full check() to cover shaping/degradation — plus one end-to-end check()
 * run against this repo's own real config, where every check is expected to
 * pass (this repo registers the scheduler MCP in its own .mcp.json and wires
 * guard-prd-writes in .claude/settings.json).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/health-delegation-chain.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { evaluateDelegationChainHealth, check } = require('../health.cjs');

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

test('end-to-end: check() reports delegation_chain for this repo, expected to pass here', async () => {
  const status = await check();
  expect(status.components.delegation_chain).toBeDefined();
  expect(status.components.delegation_chain.checks).toHaveLength(7);
  const ids = status.components.delegation_chain.checks.map((c) => c.id);
  expect(ids).toEqual([
    'scheduler-mcp',
    'scheduler-mcp-live',
    'scheduler-mcp-project-duplicate',
    'dev-plugin',
    'agent-personas',
    'prd-write-guard',
    'destructive-git-guard',
  ]);
  // This repo registers the scheduler MCP at user scope (~/.claude.json) and
  // wires guard-prd-writes in .claude/settings.json, and no longer carries a
  // project-scope duplicate in its own .mcp.json, so on this machine every
  // check is expected to pass — a failure here means the probe or the
  // wiring is wrong, not that the assertion should be relaxed.
  expect(status.components.delegation_chain.ok).toBe(true);
}, 90_000);
