/**
 * prdFrontmatterDependsOn.test.cjs — PRD 1124: `dependsOn` is a recognized,
 * patchable PRD frontmatter key. Before this PRD, RECOGNIZED_KEYS omitted
 * `dependsOn`, so it only round-tripped verbatim via `extras` and
 * scheduler_update_prd could not patch it — the only repair path for a
 * wrong dependsOn was archive-and-recreate, which is unsafe (archiving
 * marks the PRD completed, freeing its dependents with zero work done).
 *
 * Covers the pure parse/serialize contract in prdFrontmatter.cjs. The
 * write-time FK validation + clearing semantics wired into
 * scheduler.remote.updatePrd are covered by
 * prdUpdateDependsOn.test.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdFrontmatterDependsOn.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';

const { parsePrdFile, serializePrdFile, RECOGNIZED_KEYS } = require('../lib/prdFrontmatter.cjs');

test('dependsOn is a recognized key', () => {
  expect(RECOGNIZED_KEYS.has('dependsOn')).toBe(true);
});

test('parsePrdFile parses an inline dependsOn list into an array, and round-trips it byte-identically when unedited', () => {
  const raw = [
    '---',
    'title: A follow-up PRD',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 20',
    'agentType: dev-lead',
    'dependsOn: [widget-base, widget-shared]',
    '---',
    '# Goal',
    '',
    'Build on the base.',
    '',
  ].join('\n');

  const { frontmatter, body } = parsePrdFile(raw);
  expect(frontmatter.dependsOn).toEqual(['widget-base', 'widget-shared']);
  expect(serializePrdFile(frontmatter, body)).toBe(raw);
});

test('parsePrdFile leaves dependsOn undefined when omitted — a PRD with no dependsOn round-trips unaffected', () => {
  const raw = [
    '---',
    'title: An older PRD authored before dependsOn was patchable',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 10',
    '---',
    '# Goal',
    '',
    'Do the thing.',
    '',
  ].join('\n');

  const { frontmatter, body } = parsePrdFile(raw);
  expect(frontmatter.dependsOn).toBeUndefined();
  expect(serializePrdFile(frontmatter, body)).toBe(raw);

  // An unrelated patch (title) must not introduce a dependsOn line.
  const updated = serializePrdFile({ ...frontmatter, title: 'Renamed' }, body);
  expect(updated).not.toContain('dependsOn');
});

test('serializePrdFile emits a newly-set dependsOn onto a frontmatter object that lacked one', () => {
  const raw = [
    '---',
    'title: Legacy PRD',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 5',
    '---',
    'body',
    '',
  ].join('\n');

  const { frontmatter, body } = parsePrdFile(raw);
  const updated = serializePrdFile({ ...frontmatter, dependsOn: ['some-other-prd'] }, body);
  expect(updated).toContain('dependsOn: [some-other-prd]');
});

test('serializePrdFile patches an existing dependsOn to a new list', () => {
  const raw = [
    '---',
    'title: A follow-up PRD',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 20',
    'dependsOn: [widget-base]',
    '---',
    'body',
    '',
  ].join('\n');

  const { frontmatter, body } = parsePrdFile(raw);
  const updated = serializePrdFile({ ...frontmatter, dependsOn: ['widget-shared', 'widget-extra'] }, body);
  expect(updated).toContain('dependsOn: [widget-shared, widget-extra]');
  expect(updated).not.toContain('widget-base');
});

test('serializePrdFile patching dependsOn to an explicit empty array CLEARS it', () => {
  const raw = [
    '---',
    'title: A follow-up PRD',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 20',
    'dependsOn: [widget-base]',
    '---',
    'body',
    '',
  ].join('\n');

  const { frontmatter, body } = parsePrdFile(raw);
  const updated = serializePrdFile({ ...frontmatter, dependsOn: [] }, body);
  expect(updated).not.toContain('dependsOn');
});

test('unrelated recognized-key patch leaves an existing dependsOn line untouched', () => {
  const raw = [
    '---',
    'title: A follow-up PRD',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 20',
    'dependsOn: [widget-base]',
    '---',
    'body',
    '',
  ].join('\n');

  const { frontmatter, body } = parsePrdFile(raw);
  const updated = serializePrdFile({ ...frontmatter, estimateMinutes: 30 }, body);
  expect(updated).toContain('dependsOn: [widget-base]');
  expect(updated).toContain('estimateMinutes: 30');
});
