// bilkoHost.cjs's deriveSlug — pure kebab-case transform used as the
// default static-path slug when Stage A prepares a project's bundle.
const assert = require('node:assert/strict');
const { deriveSlug } = require('../bilkoHost.cjs');

test('deriveSlug: kebab-cases a plain npm package name', () => {
  assert.equal(deriveSlug('claude-code-session-manager'), 'claude-code-session-manager');
});

test('deriveSlug: lowercases and collapses non-alphanumeric runs', () => {
  assert.equal(deriveSlug('My Cool App!! v2'), 'my-cool-app-v2');
});

test('deriveSlug: trims leading/trailing separators', () => {
  assert.equal(deriveSlug('--Hello--'), 'hello');
});

test('deriveSlug: falls back to "project" for an empty/unusable name', () => {
  assert.equal(deriveSlug('   '), 'project');
  assert.equal(deriveSlug('!!!'), 'project');
});

test('deriveSlug: caps length at 64 characters', () => {
  const long = 'a'.repeat(100);
  assert.equal(deriveSlug(long).length, 64);
});
