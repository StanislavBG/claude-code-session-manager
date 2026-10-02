/**
 * configRealResolve.test.cjs — realResolve (config.cjs ~line 56) must resolve
 * a not-yet-existing path through its nearest EXISTING ancestor, walking up
 * as many levels as it takes, not just one.
 *
 * On macOS, os.tmpdir() sits under /var, a symlink to /private/var. A fresh
 * mkdtemp'd dir can be missing more than one level below it (for example
 * "<tmp>/session-manager-operations/prompt-sessions/x.json", where neither
 * subdirectory exists yet). The old realResolve only tried ONE parent hop
 * before giving up and returning the unresolved /var/... path. validatePath
 * then compared that against a sibling root that DID resolve to
 * /private/var/... and rejected every such write as "outside allowed
 * boundaries" (PRD: macOS path checks must handle new paths under a
 * symlinked dir).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/configRealResolve.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');

const cleanupPaths = [];
afterEach(() => {
  while (cleanupPaths.length) {
    const p = cleanupPaths.pop();
    fs.rmSync(p, { recursive: true, force: true });
  }
});

function uniqueSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

// Real (pre-resolved) tmp root, per this repo's own test convention — the
// cases below build their OWN symlinks deliberately, so the base dirs they
// symlink to must already be realpath'd ground truth.
const realTmpRoot = fs.realpathSync(os.tmpdir());

function mkRealDir(prefix) {
  const dir = fs.mkdtempSync(path.join(realTmpRoot, prefix));
  cleanupPaths.push(dir);
  return dir;
}

function mkSymlink(target) {
  const link = path.join(realTmpRoot, `sm-configrealresolve-link-${uniqueSuffix()}`);
  fs.symlinkSync(target, link);
  cleanupPaths.push(link);
  return link;
}

test('a new nested path (a/b/c.json, none of it exists) under a symlinked dir resolves to the real path', () => {
  const realBase = mkRealDir('sm-configrealresolve-base-');
  const linkDir = mkSymlink(realBase);

  const nested = path.join(linkDir, 'a', 'b', 'c.json');
  expect(fs.existsSync(path.join(linkDir, 'a'))).toBe(false);

  const resolved = config.realResolve(nested);
  expect(resolved).toBe(path.join(realBase, 'a', 'b', 'c.json'));
});

test('a root given through a symlink and the same root given by its real path both accept the same target, resolved to the real path either way', () => {
  const realRoot = mkRealDir('sm-configrealresolve-root-');
  const linkRoot = mkSymlink(realRoot);
  // The target itself is reached THROUGH the symlink here (unlike the real
  // path used below) — this is what makes the case fail if realResolve were
  // ever swapped back for a plain path.resolve: path.resolve would return
  // the target's lexical, still-symlinked form, which matches neither the
  // real root string validatePath checks it against nor targetViaReal below.
  const targetViaLink = path.join(linkRoot, 'nested', 'f.json');
  const targetViaReal = path.join(realRoot, 'nested', 'f.json');

  config.addAllowedRoot(linkRoot);
  const viaLinkRegistration = config.validatePath(targetViaLink);

  config.addAllowedRoot(realRoot);
  const viaRealRegistration = config.validatePath(targetViaReal);

  expect(viaLinkRegistration).toBe(targetViaReal);
  expect(viaRealRegistration).toBe(targetViaReal);
});

// Regression case: the actual bug only shows up when os.tmpdir() itself is
// used WITHOUT pre-resolving it, which is only meaningfully different from
// its realpath on macOS (/var -> /private/var). Elsewhere this is the same
// path and the case is a redundant but harmless repeat of the one above.
test.runIf(process.platform === 'darwin')(
  'darwin: a root registered via the raw (unresolved) os.tmpdir() still accepts a deep not-yet-existing nested target',
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-configrealresolve-rawtmp-'));
    cleanupPaths.push(root);
    config.addAllowedRoot(root);

    const target = path.join(root, 'session-manager-operations', 'prompt-sessions', 'active-index.json');
    expect(fs.existsSync(path.join(root, 'session-manager-operations'))).toBe(false);

    const resolved = config.validatePath(target);
    expect(resolved).toBe(fs.realpathSync(root) + target.slice(root.length));
  }
);

test('a symlink inside the root that points outside it is still rejected', () => {
  const realRoot = mkRealDir('sm-configrealresolve-root-');
  const outside = mkRealDir('sm-configrealresolve-outside-');
  config.addAllowedRoot(realRoot);

  const escape = path.join(realRoot, 'escape');
  fs.symlinkSync(outside, escape);

  expect(() => config.validatePath(path.join(escape, 'secret.json')))
    .toThrow(/Path outside allowed boundaries/);
});
