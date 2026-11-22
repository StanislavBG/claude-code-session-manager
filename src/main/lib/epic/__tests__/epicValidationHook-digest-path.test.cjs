/**
 * epicValidationHook-digest-path.test.cjs — the PLAN SETTLED digest names the
 * absolute main-checkout plan-records folder (records are never committed, so a
 * repo-relative path would point at nothing in a fresh checkout) plus the
 * legacy reviews/validation folder.
 *
 * Run: timeout 300 npx vitest run src/main/lib/epic/__tests__/epicValidationHook-digest-path.test.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSettledDigest } = require('../epicValidationHook.cjs');
const { opsPath } = require('../../opsOwnership.cjs');

describe('buildSettledDigest record folder', () => {
  /** @type {string} */
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-path-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('names the absolute plan-records folder and the legacy folder', () => {
    const digest = buildSettledDigest({ verified: ['0001-a'] }, { epicId: 'epic-1', cwd: root });
    const planDir = opsPath(root, 'plan-records', 'epic-1');
    expect(path.isAbsolute(planDir)).toBe(true);
    expect(digest).toContain(planDir + path.sep);
    expect(digest).toContain(opsPath(root, 'reviews', 'validation', 'epic-1') + path.sep);
    expect(digest).not.toContain('relative to the repository root');
  });
});
