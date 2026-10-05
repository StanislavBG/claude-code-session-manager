/**
 * loginShellPath.test.cjs — readLoginShellPath / applyLoginShellPath against
 * temp stub "shells" (executable #!/bin/sh scripts).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/loginShellPath.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLoginShellPath, applyLoginShellPath } = require('../loginShellPath.cjs');

const D = path.delimiter;
let dir;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-loginpath-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function stub(name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

const wrapped = (p) =>
  `printf '%s' '__SM_PATH_START__'; printf '%s' '${p}'; printf '%s' '__SM_PATH_END__'`;

test('readLoginShellPath returns the text between markers', async () => {
  const shell = stub('ok.sh', wrapped('/a/bin:/b/bin'));
  expect(await readLoginShellPath({ shell, platform: 'linux' })).toBe('/a/bin:/b/bin');
});

test('readLoginShellPath ignores noise before and after the markers', async () => {
  const shell = stub('noise.sh', `echo "welcome banner"; ${wrapped('/n/bin')}; echo trailing`);
  expect(await readLoginShellPath({ shell, platform: 'linux' })).toBe('/n/bin');
});

test('readLoginShellPath returns null on timeout', async () => {
  const shell = stub('sleep.sh', `sleep 5; ${wrapped('/x')}`);
  expect(await readLoginShellPath({ shell, platform: 'linux', timeoutMs: 500 })).toBeNull();
});

test('readLoginShellPath returns null on non-zero exit', async () => {
  const shell = stub('fail.sh', `${wrapped('/x')}; exit 1`);
  expect(await readLoginShellPath({ shell, platform: 'linux' })).toBeNull();
});

test('readLoginShellPath returns null when markers are missing', async () => {
  const shell = stub('nomark.sh', 'echo hello');
  expect(await readLoginShellPath({ shell, platform: 'linux' })).toBeNull();
});

test('readLoginShellPath returns null on win32', async () => {
  const shell = stub('win.sh', wrapped('/x'));
  expect(await readLoginShellPath({ shell, platform: 'win32' })).toBeNull();
});

test('applyLoginShellPath prepends new entries, deduped, order preserved', async () => {
  const shell = stub('merge.sh', wrapped(['/n/bin', '', '/usr/bin', '/n/bin', '/m/bin'].join(D)));
  const env = { PATH: ['/usr/bin', '/bin'].join(D) };
  const res = await applyLoginShellPath({ shell, platform: 'linux', env });
  expect(res).toEqual({ applied: true, added: 2 });
  expect(env.PATH).toBe(['/n/bin', '/m/bin', '/usr/bin', '/bin'].join(D));
});

test('applyLoginShellPath with nothing new reports added 0 and leaves PATH', async () => {
  const shell = stub('same.sh', wrapped('/usr/bin'));
  const env = { PATH: '/usr/bin' };
  const res = await applyLoginShellPath({ shell, platform: 'linux', env });
  expect(res).toEqual({ applied: true, added: 0 });
  expect(env.PATH).toBe('/usr/bin');
});

test('applyLoginShellPath is a no-op on win32', async () => {
  const shell = stub('w2.sh', wrapped('/x'));
  const env = { PATH: '/usr/bin' };
  expect(await applyLoginShellPath({ shell, platform: 'win32', env })).toEqual({ applied: false, added: 0 });
  expect(env.PATH).toBe('/usr/bin');
});

test('applyLoginShellPath is a no-op when the shell fails', async () => {
  const shell = stub('f2.sh', 'exit 1');
  const env = { PATH: '/usr/bin' };
  expect(await applyLoginShellPath({ shell, platform: 'linux', env })).toEqual({ applied: false, added: 0 });
  expect(env.PATH).toBe('/usr/bin');
});
