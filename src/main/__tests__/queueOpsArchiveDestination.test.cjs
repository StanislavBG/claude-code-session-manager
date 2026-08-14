/**
 * queueOpsArchiveDestination.test.cjs — an archived PRD lands beside its OWN
 * source, not in the machine-level scheduled-plans tree.
 *
 * PRD sources are per-project and per-Epic (CLAUDE.md's TAB → EPIC → PRD
 * model): `<cwd>/session-manager-operations/scheduler/epics/<epic-id>/prds/`.
 * `~/.claude/session-manager/scheduled-plans/` holds only run logs and
 * PRD_AUTHORING.md. archiveOne resolved its SOURCE per-project (findPrdDir)
 * but hardcoded its DESTINATION to the global PRDS_ARCHIVE_DIR, so a manual
 * archive yanked a PRD out of its Epic and stranded it in the retired global
 * tree — splitting one Epic's history across two locations.
 *
 * Observed 2026-08-13: archiving 1035-epic-worktree-ui-surfacing put it under
 * scheduled-plans/prds-archived/ while its three chain siblings (1032/1033/
 * 1034, archived by scheduler.cjs's own on-completion mover) sat correctly in
 * the Epic's prds-archived/. Two movers, two destinations, same operation.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/queueOpsArchiveDestination.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const path = require('node:path');
const { archiveDirForSource, PRDS_DIR, PRDS_ARCHIVE_DIR } = require('../queueOps.cjs');

const EPIC_PRDS = '/home/u/Projects/proj/session-manager-operations/scheduler/epics/my-epic-abc123/prds';
const TS = '2026-08-14T05-03-41-156Z';

test('an Epic PRD archives into that Epic\'s own prds-archived/, beside its prds/', () => {
  const dir = archiveDirForSource(EPIC_PRDS, TS);
  expect(dir).toBe(path.join(path.dirname(EPIC_PRDS), 'prds-archived', TS));
  // Concretely: same Epic dir, sibling of prds/.
  expect(dir).toBe(
    `/home/u/Projects/proj/session-manager-operations/scheduler/epics/my-epic-abc123/prds-archived/${TS}`,
  );
});

test('an Epic PRD never lands under the machine-level scheduled-plans tree', () => {
  const dir = archiveDirForSource(EPIC_PRDS, TS);
  expect(dir.startsWith(PRDS_ARCHIVE_DIR)).toBe(false);
  expect(dir).not.toContain('.claude/session-manager/scheduled-plans');
});

test('the archived PRD stays inside its own project — the ops root never changes', () => {
  const dir = archiveDirForSource(EPIC_PRDS, TS);
  expect(dir.startsWith('/home/u/Projects/proj/session-manager-operations/')).toBe(true);
});

test('two Epics in the same project archive to their own separate dirs', () => {
  const other = '/home/u/Projects/proj/session-manager-operations/scheduler/epics/other-epic-def456/prds';
  expect(archiveDirForSource(EPIC_PRDS, TS)).not.toBe(archiveDirForSource(other, TS));
});

test('a legacy flat PRD still archives to the global prds-archived/ — old behavior unchanged', () => {
  const dir = archiveDirForSource(PRDS_DIR, TS);
  expect(dir).toBe(path.join(PRDS_ARCHIVE_DIR, TS));
});

test('the batch timestamp is shared, so one archive call reads as one event', () => {
  const a = archiveDirForSource(EPIC_PRDS, TS);
  const b = archiveDirForSource('/home/u/Projects/other/session-manager-operations/scheduler/epics/e/prds', TS);
  expect(path.basename(a)).toBe(TS);
  expect(path.basename(b)).toBe(TS);
});
