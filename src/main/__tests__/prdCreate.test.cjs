/**
 * prdCreate.test.cjs — unit tests for the create-PRD body builder (PRD 549,
 * gh-issue-6). Pure-function tests only; the HTTP route + auth/cwd-boundary
 * behavior is covered by adminServer.test.cjs.
 *
 * Run: timeout 120 node --test src/main/__tests__/prdCreate.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  deriveSlugFromTitle,
  buildPrdBody,
  readStandards,
  PRD_CREATE_SLUG_RE,
} = require('../lib/prdCreate.cjs');

test('deriveSlugFromTitle lowercases, kebab-cases, and strips non-alnum runs', () => {
  assert.strictEqual(deriveSlugFromTitle('Add Foo Bar!! Baz'), 'add-foo-bar-baz');
  assert.strictEqual(deriveSlugFromTitle('  leading/trailing  '), 'leading-trailing');
});

test('deriveSlugFromTitle output always satisfies PRD_CREATE_SLUG_RE', () => {
  const slug = deriveSlugFromTitle('Some Title 123');
  assert.ok(PRD_CREATE_SLUG_RE.test(slug));
});

test('readStandards reads the real standards.md and returns non-empty text', async () => {
  const text = await readStandards();
  assert.ok(text.includes('Execution discipline'));
});

test('buildPrdBody emits required frontmatter keys and body sections in order', async () => {
  const standards = await readStandards();
  const body = buildPrdBody({
    title: 'Do the thing',
    cwd: '~/Projects/session-manager',
    estimateMinutes: 15,
    goal: 'Build the thing.',
    acceptanceCriteria: ['thing exists', 'tests pass'],
    implementationNotes: 'See file.cjs:10.',
    outOfScope: ['not this'],
  }, standards);

  assert.ok(body.startsWith('---\n'));
  assert.match(body, /title: Do the thing/);
  assert.match(body, /cwd: ~\/Projects\/session-manager/);
  assert.match(body, /estimateMinutes: 15/);

  const goalIdx = body.indexOf('# Goal');
  const acIdx = body.indexOf('# Acceptance criteria');
  const implIdx = body.indexOf('# Implementation notes');
  const oosIdx = body.indexOf('# Out of scope');
  const standardsIdx = body.indexOf('## Engineering standards');
  assert.ok(goalIdx > 0 && goalIdx < acIdx && acIdx < implIdx && implIdx < oosIdx && oosIdx < standardsIdx,
    'sections must appear in Goal -> AC -> Implementation notes -> Out of scope -> Engineering standards order');

  assert.match(body, /- \[ \] thing exists/);
  assert.match(body, /- \[ \] tests pass/);
  assert.match(body, /- not this/);
  assert.ok(body.includes('Execution discipline'), 'must inline the standards.md content verbatim');
});

test('buildPrdBody omits parallelGroup frontmatter key when not supplied', () => {
  const body = buildPrdBody({
    title: 't', cwd: '~/x', estimateMinutes: 5, goal: 'g',
    acceptanceCriteria: ['a'], implementationNotes: 'n',
  }, 'standards text');
  assert.ok(!/parallelGroup:/.test(body));
});

test('readStandards result is byte-identical to the on-disk file (single source of truth)', async () => {
  const path = require('node:path');
  const onDisk = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'plugins', 'session-manager-dev', 'skills', 'develop', 'standards.md'),
    'utf8',
  );
  assert.strictEqual(await readStandards(), onDisk);
});
