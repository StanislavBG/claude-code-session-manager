/**
 * planValidator.test.cjs — unit tests for hasDownstreamValidator (PRD 1408).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/planValidator.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { hasDownstreamValidator } = require('../lib/planValidator.cjs');

test('true when a pending validator row depends on the job', () => {
  const job = { slug: '111-alpha' };
  const jobs = [
    job,
    { slug: '999-validate', agentType: 'validator', status: 'pending', dependsOn: ['111-alpha'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(true);
});

test('true when the depending validator row is running', () => {
  const job = { slug: '111-alpha' };
  const jobs = [
    job,
    { slug: '999-validate', agentType: 'validator', status: 'running', dependsOn: ['111-alpha'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(true);
});

test('false when the job itself is a validator', () => {
  const job = { slug: '999-validate', agentType: 'validator' };
  const jobs = [
    job,
    { slug: '998-other-validate', agentType: 'validator', status: 'pending', dependsOn: ['999-validate'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(false);
});

test('false for null/undefined job or jobs', () => {
  expect(hasDownstreamValidator(null, [{ slug: 'x' }])).toBe(false);
  expect(hasDownstreamValidator(undefined, [{ slug: 'x' }])).toBe(false);
  expect(hasDownstreamValidator({ slug: '111-alpha' }, null)).toBe(false);
  expect(hasDownstreamValidator({ slug: '111-alpha' }, undefined)).toBe(false);
});

test('false when the validator row does not depend on this job', () => {
  const job = { slug: '111-alpha' };
  const jobs = [
    job,
    { slug: '999-validate', agentType: 'validator', status: 'pending', dependsOn: ['222-beta'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(false);
});

test('false when the depending row is a completed validator', () => {
  const job = { slug: '111-alpha' };
  const jobs = [
    job,
    { slug: '999-validate', agentType: 'validator', status: 'completed', dependsOn: ['111-alpha'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(false);
});

test('false when the depending row is not agentType validator', () => {
  const job = { slug: '111-alpha' };
  const jobs = [
    job,
    { slug: '999-other', agentType: 'dev-lead', status: 'pending', dependsOn: ['111-alpha'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(false);
});
