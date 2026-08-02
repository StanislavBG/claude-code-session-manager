// bilkoHostCore.cjs — pure multi-document bundle logic for the "Host on
// Bilko.run" tab (subpath validation, document-set invariants, path/URL math).
const assert = require('node:assert/strict');
const {
  validateSubpath,
  validateDocumentSet,
  documentDistRelPath,
  documentUrl,
} = require('../bilkoHostCore.cjs');

test('validateSubpath: "" (root) is always valid', () => {
  assert.equal(validateSubpath('').ok, true);
});

test('validateSubpath: accepts lowercase kebab-case, single or multi-segment', () => {
  assert.equal(validateSubpath('special-doc').ok, true);
  assert.equal(validateSubpath('special-doc/01').ok, true);
  assert.equal(validateSubpath('a/b/c').ok, true);
});

test('validateSubpath: rejects leading/trailing slash', () => {
  assert.equal(validateSubpath('/foo').ok, false);
  assert.equal(validateSubpath('foo/').ok, false);
});

test('validateSubpath: rejects uppercase, spaces, dot-segments', () => {
  assert.equal(validateSubpath('Foo').ok, false);
  assert.equal(validateSubpath('foo bar').ok, false);
  assert.equal(validateSubpath('..').ok, false);
  assert.equal(validateSubpath('foo/../bar').ok, false);
});

test('validateSubpath: rejects excessive depth or length', () => {
  assert.equal(validateSubpath(Array(10).fill('a').join('/')).ok, false);
  assert.equal(validateSubpath('a'.repeat(300)).ok, false);
});

test('validateDocumentSet: requires exactly one root document', () => {
  assert.equal(validateDocumentSet([]).ok, false);
  assert.equal(validateDocumentSet([{ id: '1', subpath: 'x' }]).ok, false);
  assert.equal(validateDocumentSet([{ id: '1', subpath: '' }]).ok, true);
  assert.equal(
    validateDocumentSet([{ id: '1', subpath: '' }, { id: '2', subpath: '' }]).ok,
    false,
  );
});

test('validateDocumentSet: rejects duplicate subpaths', () => {
  const res = validateDocumentSet([
    { id: '1', subpath: '' },
    { id: '2', subpath: 'doc' },
    { id: '3', subpath: 'doc' },
  ]);
  assert.equal(res.ok, false);
  assert.match(res.error, /duplicate subpath/);
});

test('validateDocumentSet: propagates a bad segment error with the document id', () => {
  const res = validateDocumentSet([{ id: '1', subpath: '' }, { id: 'bad-doc', subpath: 'Not Ok' }]);
  assert.equal(res.ok, false);
  assert.match(res.error, /bad-doc/);
});

test('documentDistRelPath: root -> index.html, sub-path -> <subpath>/index.html', () => {
  assert.equal(documentDistRelPath(''), 'index.html');
  assert.equal(documentDistRelPath('special-doc/01'), 'special-doc/01/index.html');
});

test('documentUrl: root has no sub-path segment, sub-path is nested under the slug', () => {
  assert.equal(documentUrl('my-app', ''), 'https://bilko.run/projects/my-app/');
  assert.equal(documentUrl('my-app', 'special-doc/01'), 'https://bilko.run/projects/my-app/special-doc/01/');
});
