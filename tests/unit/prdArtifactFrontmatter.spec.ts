import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePrdFile, serializePrdFile } = require('../../src/main/lib/prdFrontmatter.cjs');

const wrap = (fm: string) => `---\n${fm}\n---\n# Goal\nbody\n`;

describe('artifact-only PRD frontmatter', () => {
  const both = wrap(
    'title: t\ncwd: /x\nestimateMinutes: 5\ndisposition: append\ndeliverable: artifact\nartifactPaths: [a/b.patch, c.md]',
  );

  it('parses deliverable + artifactPaths', () => {
    const { frontmatter: fm } = parsePrdFile(both);
    expect(fm.deliverable).toBe('artifact');
    expect(fm.artifactPaths).toHaveLength(2);
    expect(fm.artifactPaths).toEqual(['a/b.patch', 'c.md']);
  });

  it('drops an unrecognized deliverable value', () => {
    const { frontmatter: fm } = parsePrdFile(wrap('title: t\ndeliverable: something-else'));
    expect('deliverable' in fm).toBe(false);
  });

  it('round-trips byte-identically', () => {
    const { frontmatter, body } = parsePrdFile(both);
    expect(serializePrdFile(frontmatter, body)).toBe(both);
  });

  it('adds no new keys when neither field is present', () => {
    const { frontmatter: fm } = parsePrdFile(wrap('title: t\ncwd: /x'));
    expect('deliverable' in fm).toBe(false);
    expect('artifactPaths' in fm).toBe(false);
  });
});
