/**
 * prdFrontmatterDisposition.test.cjs — scheduler wave-disposition PRD:
 * `disposition` ('append' | 'new-head') is a recognized, patchable PRD
 * frontmatter key, same pattern as `dependsOn` in
 * prdFrontmatterDependsOn.test.cjs. It records the authoring-time decision
 * for a wave's root PRD: does it extend the Epic's existing dependsOn chain
 * (append) or start an independent, parallel-eligible chain (new-head)?
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdFrontmatterDisposition.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';

const { parsePrdFile, serializePrdFile, RECOGNIZED_KEYS } = require('../lib/prdFrontmatter.cjs');

test('disposition is a recognized key', () => {
  expect(RECOGNIZED_KEYS.has('disposition')).toBe(true);
});

test('parsePrdFile parses disposition: append and round-trips it byte-identically when unedited', () => {
  const raw = [
    '---',
    'title: A second wave',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 20',
    'dependsOn: [widget-base]',
    'disposition: append',
    '---',
    '# Goal',
    '',
    'Extend the chain.',
    '',
  ].join('\n');

  const { frontmatter, body } = parsePrdFile(raw);
  expect(frontmatter.disposition).toBe('append');
  expect(serializePrdFile(frontmatter, body)).toBe(raw);
});

test('parsePrdFile parses disposition: new-head', () => {
  const raw = [
    '---',
    'title: A parallel wave',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 20',
    'disposition: new-head',
    '---',
    'body',
    '',
  ].join('\n');

  const { frontmatter } = parsePrdFile(raw);
  expect(frontmatter.disposition).toBe('new-head');
});

test('parsePrdFile leaves disposition unset for an unrecognized value rather than throwing', () => {
  const raw = [
    '---',
    'title: A hand-edited PRD',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 20',
    'disposition: sideways',
    '---',
    'body',
    '',
  ].join('\n');

  const { frontmatter } = parsePrdFile(raw);
  expect(frontmatter.disposition).toBeUndefined();
});

test('parsePrdFile leaves disposition undefined when omitted — a PRD authored before this field existed round-trips unaffected', () => {
  const raw = [
    '---',
    'title: An older PRD',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 10',
    '---',
    '# Goal',
    '',
    'Do the thing.',
    '',
  ].join('\n');

  const { frontmatter, body } = parsePrdFile(raw);
  expect(frontmatter.disposition).toBeUndefined();
  expect(serializePrdFile(frontmatter, body)).toBe(raw);
});

test('serializePrdFile emits a newly-set disposition onto a frontmatter object that lacked one', () => {
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
  const updated = serializePrdFile({ ...frontmatter, disposition: 'new-head' }, body);
  expect(updated).toContain('disposition: new-head');
});

test('serializePrdFile patches an existing disposition (promoting append to new-head)', () => {
  const raw = [
    '---',
    'title: A second wave',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 20',
    'dependsOn: [widget-base]',
    'disposition: append',
    '---',
    'body',
    '',
  ].join('\n');

  const { frontmatter, body } = parsePrdFile(raw);
  const updated = serializePrdFile({ ...frontmatter, dependsOn: [], disposition: 'new-head' }, body);
  expect(updated).toContain('disposition: new-head');
  expect(updated).not.toContain('dependsOn');
});
