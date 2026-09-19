'use strict';

/**
 * writeClaudeStub — the single writer of executable `claude` stubs for tests.
 * The stub lives inside the per-run sandbox (never the shared tmpdir) and, when
 * it runs git, refuses unless process.cwd() is under `allowCommitUnder` — a stub
 * once `git add -A && git commit`ed the REAL repo it was spawned in.
 *
 *   writeClaudeStub({ body, allowCommitUnder })
 *     body            JS run by the stub (CommonJS). Default: emit a stream-json
 *                     success result and exit 0. Inside `body`, use `runGit(args)`
 *                     for git — it enforces the allowCommitUnder guard.
 *     allowCommitUnder  absolute dir; omitted → the stub may not run git at all.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_BODY = `
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
process.exit(0);
`;

const written = new Set();

function stubDir() {
  const base = process.env.SM_SANDBOX_DIR || os.tmpdir();
  const dir = path.join(base, 'claude-stubs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeClaudeStub({ body = DEFAULT_BODY, allowCommitUnder } = {}) {
  const stubPath = path.join(stubDir(), `stub-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const allow = allowCommitUnder ? path.resolve(allowCommitUnder) : null;
  const prelude = `
const __cp = require('node:child_process');
const __path = require('node:path');
const __allow = ${JSON.stringify(allow)};
function runGit(args, opts) {
  const cwd = __path.resolve(process.cwd());
  const rel = __allow ? __path.relative(__allow, cwd) : null;
  if (rel === null || rel.startsWith('..') || __path.isAbsolute(rel)) {
    process.stderr.write('claudeStub: refusing git in ' + cwd + ' (allowCommitUnder=' + __allow + ')\\n');
    process.exit(97);
  }
  return __cp.execFileSync('git', args, Object.assign({ cwd, encoding: 'utf8' }, opts));
}
`;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${prelude}\n${body}\n`, { mode: 0o755 });
  written.add(stubPath);
  return stubPath;
}

function reapClaudeStubs() {
  for (const p of written) {
    try { fs.rmSync(p, { force: true }); } catch { /* best effort */ }
  }
  written.clear();
}

module.exports = { writeClaudeStub, reapClaudeStubs };
