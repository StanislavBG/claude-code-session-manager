/**
 * prdGateFiles.test.cjs — validateGate / validateFiles coverage for the
 * no-shell command-chain rules (definitionOfDone.cjs's tokenizeNoShell /
 * explainChain) and the stricter files checks, plus a gate round trip
 * through renderGateSection + resolveGate.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/prdGateFiles.test.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const { validateGate, validateFiles, renderGateSection } = require('../prdGateFiles.cjs');
const { resolveGate, parseChain } = require('../definitionOfDone.cjs');

// Brief's exact 8 "accepts, with no warning" gate strings.
const ACCEPTED_GATE_ENTRIES = [
  'timeout 300 npm run typecheck',
  'TMPDIR=$(mktemp -d) timeout 600 npx vitest run src/x.test.cjs',
  'FOO="a b" timeout 10 node x.js',
  'timeout 10s node x.js',
  'timeout 10 git diff HEAD~1 --stat',
  "timeout 30 rg -n 'a|b' src/",
  "timeout 30 node -e 'console.log(1)'",
  `timeout 30 node -e "require('x')"`,
];

test('validateGate accepts every well-formed no-shell entry with no warning', () => {
  for (const entry of ACCEPTED_GATE_ENTRIES) {
    const result = validateGate([entry]);
    assert.equal(result.ok, true, entry);
    assert.deepEqual(result.warnings, [], entry);
    assert.deepEqual(result.commands, [entry], entry);
  }
});

test('validateGate warns when a step has no leading timeout', () => {
  const result = validateGate(['npx vitest run src/x.test.cjs']);
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /does not start with "timeout <seconds>"/);
});

// Brief's 19 syntax-refusal cases plus the 5 near-miss "none" cases, each
// paired with a distinctive substring of its expected, own error message.
const REFUSED_GATE_CASES = [
  ['$HOME', 'unquoted "$"'],
  ['"$HOME"', 'inside double quotes'],
  ['"$(id)"', 'inside double quotes'],
  ['`id`', 'unquoted "`"'],
  ['a\\ b', 'unquoted "\\"'],
  ['src/*.cjs', 'unquoted "*"'],
  ['a?b', 'unquoted "?"'],
  ['[a]', 'unquoted "["'],
  ['{a,b}', 'unquoted "{"'],
  ['(x)', 'unquoted "("'],
  ['!x', 'unquoted "!"'],
  ['#c', 'must not start with "#"'],
  ['~/x', 'at the start of a word or after "=" or ":"'],
  ['--dir=~/x', 'at the start of a word or after "=" or ":"'],
  ['PATH=a:~/b', 'at the start of a word or after "=" or ":"'],
  ['echo hi', 'not a plain space or tab'],
  ['echo hi', 'not a plain space or tab'],
  ['timeout 10 echo a &&', 'Check the "&&" joins'],
  ['timeout 10', 'no command after "timeout"'],
  ['none.', 'write exactly none, with nothing else'],
  ['none (docs only)', 'write exactly none, with nothing else'],
  ['"none"', 'write exactly none, with nothing else'],
  ['none # docs', 'write exactly none, with nothing else'],
  ['NONE!', 'write exactly none, with nothing else'],
];

test('validateGate refuses each syntax a shell would read differently, and each near-miss none, with its own message', () => {
  assert.equal(REFUSED_GATE_CASES.length, 24);
  for (const [entry, expectedSubstring] of REFUSED_GATE_CASES) {
    const result = validateGate([entry]);
    assert.equal(result.ok, false, entry);
    assert.ok(
      result.error.includes(expectedSubstring),
      `${JSON.stringify(entry)} -> ${JSON.stringify(result.error)} does not include ${JSON.stringify(expectedSubstring)}`,
    );
  }
});

test('validateGate(["none"]) is the opt-out, case- and whitespace-insensitive', () => {
  for (const noneForm of ['none', 'None', ' none ']) {
    const result = validateGate([noneForm]);
    assert.equal(result.ok, true, noneForm);
    assert.deepEqual(result.commands, ['none'], noneForm);
    assert.equal(result.warnings.length, 1, noneForm);
    assert.match(result.warnings[0], /Gate is none/, noneForm);
  }
});

test('validateFiles refuses a dot-becomes-empty, a bare dot, a leading dash, a backslash, dot/empty segments, backticks and foreign whitespace', () => {
  const cases = [
    ['./', 'is empty after removing "./"'],
    ['.', 'must not contain a "." path segment'],
    ['-rf', 'must not start with "-"'],
    ['a\\b', 'use "/" between folders, not "\\"'],
    ['a/./b', 'must not contain a "." path segment'],
    ['a//b', 'must not contain an empty path segment'],
    ['a`b', 'must not contain a backtick'],
    ['```gate', 'must not contain a backtick'],
    ['a b', 'not a plain space'],
    ['a b', 'not a plain space'],
  ];
  for (const [entry, expectedSubstring] of cases) {
    const result = validateFiles([entry]);
    assert.equal(result.ok, false, entry);
    assert.ok(
      result.error.includes(expectedSubstring),
      `${JSON.stringify(entry)} -> ${JSON.stringify(result.error)} does not include ${JSON.stringify(expectedSubstring)}`,
    );
  }
});

test('validateFiles strips every leading "./", keeps a trailing "/", and collapses duplicates', () => {
  const stripped = validateFiles(['././src/a.cjs']);
  assert.equal(stripped.ok, true);
  assert.deepEqual(stripped.files, ['src/a.cjs']);

  const kept = validateFiles(['src/']);
  assert.equal(kept.ok, true);
  assert.deepEqual(kept.files, ['src/']);

  const deduped = validateFiles(['././src/a.cjs', 'src/a.cjs']);
  assert.equal(deduped.ok, true);
  assert.deepEqual(deduped.files, ['src/a.cjs']);
});

test('round trip: renderGateSection + resolveGate reproduces parseChain for every accepted entry', () => {
  for (const entry of ACCEPTED_GATE_ENTRIES) {
    const body = renderGateSection([entry]).join('\n');
    const resolved = resolveGate(body);
    assert.equal(resolved.source, 'explicit', entry);
    assert.deepEqual(resolved.sequence, parseChain(entry), entry);
  }
});
