'use strict';

// Run: timeout 120 npx vitest run src/main/lib/claude/__tests__/oneShotNoMcp.test.cjs

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const cp = require('node:child_process');
const claudeBinLib = require('../claudeBin.cjs');
const caps = require('../claudeCliCaps.cjs');

test('runClaudeP spawns with --strict-mcp-config and never --mcp-config', async () => {
  const origSpawn = cp.spawn;
  const origResolve = claudeBinLib.resolveClaudeBin;
  let captured = null;
  cp.spawn = (command, args) => {
    captured = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  claudeBinLib.resolveClaudeBin = () => '/bin/true';
  caps._resetForTest();
  caps._setExecFileForTest((_bin, _args, _opts, cb) => cb(null, ''));
  try {
    delete require.cache[require.resolve('../runClaudeP.cjs')];
    const { runClaudeP } = require('../runClaudeP.cjs');
    const res = await runClaudeP('hi', { model: 'sonnet' });
    assert.equal(res.ok, true);
    assert.ok(captured.includes('--strict-mcp-config'));
    assert.ok(!captured.includes('--mcp-config'));
  } finally {
    cp.spawn = origSpawn;
    claudeBinLib.resolveClaudeBin = origResolve;
    caps._setExecFileForTest(null);
    caps._resetForTest();
    delete require.cache[require.resolve('../runClaudeP.cjs')];
  }
});
