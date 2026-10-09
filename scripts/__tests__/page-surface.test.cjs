/**
 * page-surface.test.cjs — page discovery + import-graph split against the real repo, plus a
 * tmp-dir fixture for the specifier-resolution edge cases.
 *
 * Run: timeout 300 npx vitest run scripts/__tests__/page-surface.test.cjs
 */
'use strict';

import { test, expect, describe } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listPages, importGraph, classifyPages } = require('../page-surface.cjs');

const ROOT = path.resolve(__dirname, '../..');

describe('real repo', () => {
  const pages = listPages(ROOT);
  const byKey = Object.fromEntries(pages.map((p) => [p.key, p]));

  test('listPages resolves faces and entries from the nav registry', () => {
    expect(byKey.skills.entry).toBe('src/renderer/components/tabs/Skills.tsx');
    expect(byKey.skills.faces).toEqual(['home']);
    expect(byKey.overview.entry).toBe('src/renderer/components/tabs/Home.tsx');
    expect(byKey.voice.entry).toBe('src/renderer/components/layout/VoiceModal.tsx');
    expect(byKey.terminal.entry).toBeNull();
    expect(byKey.projects.faces).toEqual(['home', 'project']);
    expect(byKey.editor).toBeUndefined();
  });

  test('classifyPages splits owned from shared', () => {
    const c = classifyPages(ROOT);
    const skills = c.skills;
    expect(skills.owned).toContain('src/renderer/components/tabs/Skills.tsx');
    const sharedFiles = skills.shared.map((s) => s.file);
    expect(skills.owned).not.toContain('src/renderer/components/tabs/Hooks.tsx');
    expect(sharedFiles).not.toContain('src/renderer/components/tabs/Hooks.tsx');
    expect(skills.owned).toEqual([...skills.owned].sort());
    for (const s of skills.shared) expect(s.pages.length).toBeGreaterThanOrEqual(2);
  });
});

describe('fixture', () => {
  test('?url suffix, directory index and dynamic import all resolve', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-surface-'));
    try {
      const w = (rel, text) => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), text);
      };
      w('src/renderer/a.tsx', "import u from './b?url'\nimport D from './dir'\nimport './style.css'\nimport React from 'react'\nexport const x = () => import('./c')\n");
      w('src/renderer/b.ts', 'export default 1\n');
      w('src/renderer/dir/index.tsx', 'export default 2\n');
      w('src/renderer/c.ts', 'export default 3\n');
      w('src/renderer/style.css', 'a{}\n');
      expect(importGraph(root, 'src/renderer/a.tsx')).toEqual([
        'src/renderer/a.tsx',
        'src/renderer/b.ts',
        'src/renderer/c.ts',
        'src/renderer/dir/index.tsx',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
