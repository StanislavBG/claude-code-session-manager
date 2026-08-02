// buildTarget.cjs — resolves a project's publish destination for 'build'-tagged Epics.
// vitest globals (test/beforeEach/afterEach) — same convention as the other .cjs tests.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveBuildTarget } = require('../buildTarget.cjs');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-build-target-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('explicit config file present is returned verbatim', () => {
  const archDir = path.join(tmpDir, 'session-manager-operations', 'architecture');
  fs.mkdirSync(archDir, { recursive: true });
  const config = {
    registry: 'npm',
    packageName: 'my-pkg',
    versionBumpPolicy: 'conventional-commits',
    gates: ['typecheck'],
  };
  fs.writeFileSync(path.join(archDir, 'build-target.json'), JSON.stringify(config));

  assert.deepEqual(resolveBuildTarget(tmpDir), config);
});

test('no config but package.json has name and is not private auto-discovers', () => {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'auto-pkg' }));

  assert.deepEqual(resolveBuildTarget(tmpDir), {
    registry: 'npm',
    packageName: 'auto-pkg',
    versionBumpPolicy: 'conventional-commits',
    gates: [],
    discovered: true,
  });
});

test('no config and package.json is private returns null', () => {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'priv-pkg', private: true }));

  assert.equal(resolveBuildTarget(tmpDir), null);
});

test('no config and no package.json returns null', () => {
  assert.equal(resolveBuildTarget(tmpDir), null);
});
