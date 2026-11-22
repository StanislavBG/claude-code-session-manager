// externalContract.cjs — owner of the outside-contract version number.
// vitest globals (test/expect) — same convention as the other .cjs tests.
'use strict';

const { CONTRACT_VERSION, contractInfo } = require('../externalContract.cjs');

test('CONTRACT_VERSION is the integer 1', () => {
  expect(CONTRACT_VERSION).toBe(1);
  expect(Number.isInteger(CONTRACT_VERSION)).toBe(true);
});

test('contractInfo() returns contractVersion and the package.json appVersion', () => {
  const appVersion = require('../../../../package.json').version;
  expect(contractInfo()).toEqual({ contractVersion: 1, appVersion });
});

test('contractInfo() returns a fresh object each call', () => {
  const a = contractInfo();
  a.contractVersion = 99;
  expect(contractInfo().contractVersion).toBe(1);
});
