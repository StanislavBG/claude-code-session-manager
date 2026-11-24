// @ts-check
'use strict';

// Every tracked persona (project overlays in .claude/agents/ and shipped
// seeds in src/seed/agents/) must pass the persona frontmatter schema —
// dispatch and mint refuse an invalid one, so a tracked file that fails it
// breaks the next install.
const fs = require('node:fs');
const path = require('node:path');
import { describe, it, expect } from 'vitest';
const { validatePersonaFrontmatter } = require('../personaFrontmatterSchema.cjs');
// The same parser dispatch (resolvePrdPersonaForSpawn) uses, so the two can never disagree.
const { splitFrontmatter } = require('../../claude/agentModelResolve.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const DIRS = ['.claude/agents', 'src/seed/agents'];

/** @returns {string[]} repo-relative paths of every tracked persona .md */
function personaFiles() {
  const out = [];
  for (const dir of DIRS) {
    const abs = path.join(REPO_ROOT, dir);
    for (const name of fs.readdirSync(abs).sort()) {
      if (name.endsWith('.md')) out.push(`${dir}/${name}`);
    }
  }
  return out;
}

describe('tracked personas', () => {
  const files = personaFiles();

  it('finds personas in both directories', () => {
    for (const dir of DIRS) {
      expect(files.some((f) => f.startsWith(`${dir}/`)), `no .md under ${dir}`).toBe(true);
    }
  });

  it('every tracked persona passes validatePersonaFrontmatter', () => {
    const failures = [];
    for (const rel of files) {
      const { fm } = splitFrontmatter(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      const check = validatePersonaFrontmatter(fm);
      if (!check.ok) failures.push(`${rel}: ${check.errors.join('; ')}`);
    }
    expect(failures, `invalid persona frontmatter:\n${failures.join('\n')}`).toEqual([]);
  });
});
