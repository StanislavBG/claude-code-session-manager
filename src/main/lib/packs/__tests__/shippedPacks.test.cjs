'use strict';
import { test, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const { listPacks, bundledPacksDir } = require('../packCatalog.cjs');

/** Parse a leading `---` frontmatter block into a flat key → value map, or null. */
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!m) return null;
  /** @type {Record<string,string>} */
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

const { packs, errors } = listPacks();

test('every shipped pack validates', () => {
  expect(errors).toEqual([]);
});

test('every shipped pack skill has name + description frontmatter', () => {
  for (const pack of packs) {
    expect(path.dirname(pack.dir)).toBe(bundledPacksDir());
    const skillsDir = path.join(pack.dir, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    for (const ent of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const file = path.join(skillsDir, ent.name, 'SKILL.md');
      expect(fs.existsSync(file), `${file} missing`).toBe(true);
      const fm = frontmatter(fs.readFileSync(file, 'utf8'));
      expect(fm, `${file} has no leading frontmatter`).not.toBeNull();
      expect(fm && fm.name, `${file} frontmatter lacks name`).toBeTruthy();
      expect(fm && fm.description, `${file} frontmatter lacks description`).toBeTruthy();
    }
  }
});
