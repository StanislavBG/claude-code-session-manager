/**
 * supervisor-probe-stdin.test.cjs — runProbe feeds its prompt on stdin, never argv
 * (a >128 KB argv element fails spawn with E2BIG).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/supervisor-probe-stdin.test.cjs
 */
'use strict';

import { test, expect, afterAll } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeClaudeStub, reapClaudeStubs } = require('../../../tests/helpers/claudeStub.cjs');
const { runProbe } = require('../supervisor.cjs');

afterAll(() => reapClaudeStubs());

test('runProbe delivers the prompt on stdin with no prompt element in argv', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.SM_SANDBOX_DIR || os.tmpdir(), 'probe-stdin-'));
  const outFile = path.join(dir, 'seen.json');
  const stub = writeClaudeStub({
    body: `
const prompt = readPrompt();
require('node:fs').writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ argv: process.argv.slice(2), prompt }));
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: '{"verdict":"ok","action":"none"}' }) + '\\n');
process.exit(0);
`,
  });
  const prompt = 'PROBE-PROMPT-' + 'y'.repeat(300 * 1024);
  await runProbe(stub, prompt);

  const seen = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  expect(seen.prompt).toBe(prompt);
  expect(seen.argv.some((a) => a.includes('PROBE-PROMPT-'))).toBe(false);
  expect(seen.argv[seen.argv.indexOf('-p') + 1]).toBe('--model');
  expect(seen.argv.slice(-2)).toEqual(['--allowedTools', 'Bash']);
  fs.rmSync(dir, { recursive: true, force: true });
}, 30000);
