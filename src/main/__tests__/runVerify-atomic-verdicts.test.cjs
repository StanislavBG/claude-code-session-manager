import { test, expect, vi } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'runVerify.cjs'), 'utf8');

test('verdicts sidecar write goes through config.writeJsonSync, not bare writeFileSync', () => {
  expect(src).not.toMatch(/writeFileSync\(verdictsPath/);
  expect(src).toMatch(/config\.cjs'\)\.writeJsonSync\(verdictsPath/);
});

test('conclude() invokes the atomic helper at runtime', async () => {
  const config = require('../config.cjs');
  const spy = vi.spyOn(config, 'writeJsonSync').mockReturnValue({ ok: true, mtimeMs: 0 });
  const { verifyRun } = require('../runVerify.cjs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-atomic-'));
  try {
    try {
      await verifyRun({ queueEntry: { slug: 's' }, runDir: dir, prdPath: path.join(dir, 'none.md'), exitCode: 0 });
    } catch { /* signature drift is fine; assert only on the spy */ }
    expect(spy.mock.calls.some(([p]) => p === path.join(dir, 's.verdicts.json'))).toBe(true);
  } finally {
    spy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
