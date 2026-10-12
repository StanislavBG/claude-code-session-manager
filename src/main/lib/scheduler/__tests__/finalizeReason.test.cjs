'use strict';

const assert = require('node:assert/strict');
const { finalizeReasonFor } = require('../finalizeReason.cjs');

describe('finalizeReasonFor', () => {
  it('needs_review carries verdict and reason', () => {
    assert.equal(
      finalizeReasonFor({ effectiveStatus: 'needs_review', verifyResult: { verdict: 'transcript_errors', reason: '3 errors' }, exitCode: 0 }),
      'needs_review: transcript_errors — 3 errors',
    );
  });
  it('needs_review omits absent reason', () => {
    assert.equal(
      finalizeReasonFor({ effectiveStatus: 'needs_review', verifyResult: { verdict: 'verify_unavailable' }, exitCode: 0 }),
      'needs_review: verify_unavailable',
    );
  });
  it('sigtermOverrideReason wins', () => {
    assert.equal(
      finalizeReasonFor({ effectiveStatus: 'needs_review', verifyResult: { verdict: 'x', reason: 'y' }, sigtermOverrideReason: 'sigterm', exitCode: 143 }),
      'sigterm',
    );
  });
  it('already_satisfied_on_main keeps verifier reason', () => {
    assert.equal(
      finalizeReasonFor({ effectiveStatus: 'completed', verifyResult: { verdict: 'already_satisfied_on_main', reason: 'on abc123' }, exitCode: 0 }),
      'on abc123',
    );
  });
  it('otherwise falls back to exit code', () => {
    assert.equal(finalizeReasonFor({ effectiveStatus: 'completed', verifyResult: null, exitCode: 0 }), 'run finished with exit 0');
  });
});
