/**
 * runClaudeP.test.cjs — the prompt travels on stdin, never in argv (E2BIG at 128 KB).
 *
 * Run: timeout 120 npx vitest run src/main/lib/claude/__tests__/runClaudeP.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeClaudeStub, reapClaudeStubs } = require('../../../../../tests/helpers/claudeStub.cjs');
const { runClaudeP } = require('../runClaudeP.cjs');

const prevBin = process.env.SM_CLAUDE_BIN;
afterEach(() => {
  if (prevBin === undefined) delete process.env.SM_CLAUDE_BIN; else process.env.SM_CLAUDE_BIN = prevBin;
  reapClaudeStubs();
});

test('a 300 KB prompt goes over stdin; no argv element reaches 128 KB', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclaudep-'));
  const argvFile = path.join(dir, 'argv.json');
  process.env.SM_CLAUDE_BIN = writeClaudeStub({
    body: `
if (process.argv.indexOf('-p') < 0) { process.stdout.write('stub 0.0.0\\n'); process.exit(0); }
require('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(String(Buffer.byteLength(readPrompt(), 'utf8')));
process.exit(0);
`,
  });
  const prompt = 'x'.repeat(300 * 1024);
  const res = await runClaudeP(prompt, { model: 'sonnet', timeoutMs: 60_000 });
  expect(res.ok).toBe(true);
  expect(res.out.trim()).toBe(String(300 * 1024));
  const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  expect(argv[0]).toBe('-p');
  expect(argv[1]).toBe('--model');
  for (const a of argv) expect(Buffer.byteLength(a, 'utf8')).toBeLessThan(131072);
  fs.rmSync(dir, { recursive: true, force: true });
});
