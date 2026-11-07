'use strict';

// Run: timeout 120 npx vitest run src/main/lib/__tests__/activeSessions-drop-roots-once.test.cjs
//
// deriveCwds must read the tmpDropRoots getters once per call, not once per
// transcript record (the getter chain does mkdirSync work).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  activeProjectCwds, __resetProjectCwdCacheForTests,
} = require('../activeSessions.cjs');

function writeTranscript(projectsDir, slug, cwd) {
  const projDir = path.join(projectsDir, slug);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 's.jsonl'), JSON.stringify({ cwd }) + '\n');
}

test('prefixDropRoots is read exactly once per call; drop and keep rules unchanged', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'active-sessions-drop-once-'));
  try {
    const projectsDir = path.join(base, 'projects');
    const dropRoot = path.join(base, 'scratch');
    const exactDir = path.join(base, 'exact');
    const nested = path.join(dropRoot, 'nested');
    const keep = path.join(base, 'keep');
    for (const d of [dropRoot, exactDir, nested, keep]) fs.mkdirSync(d, { recursive: true });
    writeTranscript(projectsDir, 'slug-nested', nested);
    writeTranscript(projectsDir, 'slug-exact', exactDir);
    writeTranscript(projectsDir, 'slug-keep', keep);
    for (let i = 0; i < 20; i++) {
      const d = path.join(base, `proj-${i}`);
      fs.mkdirSync(d);
      writeTranscript(projectsDir, `slug-${i}`, d);
    }

    let prefixReads = 0;
    let exactReads = 0;
    const tmpDropRoots = {
      get prefixDropRoots() { prefixReads += 1; return [dropRoot]; },
      get exactDropCwds() { exactReads += 1; return [exactDir]; },
    };

    __resetProjectCwdCacheForTests();
    const result = activeProjectCwds(Infinity, { projectsDir, tmpDropRoots });

    assert.equal(prefixReads, 1, 'prefixDropRoots must be read exactly once per call');
    assert.equal(exactReads, 1, 'exactDropCwds must be read exactly once per call');
    assert.ok(!result.includes(nested), 'cwd under a prefix drop root is dropped');
    assert.ok(!result.includes(exactDir), 'cwd equal to an exact drop cwd is dropped');
    assert.ok(result.includes(keep), 'a normal project dir is kept');
    assert.equal(result.length, 21);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
