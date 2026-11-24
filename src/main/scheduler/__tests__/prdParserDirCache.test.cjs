'use strict';

// prdParser.listPrdFiles must cache per prdsDir: scheduler.cjs scans every
// Epic prds/ folder in parallel, and folders often share one mtime tick.
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const prdParser = require('../prdParser.cjs');

describe('prdParser.listPrdFiles per-dir cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prd-dir-cache-'));
  let a;
  let b;

  beforeEach(() => {
    prdParser._resetCache();
    a = fs.mkdtempSync(path.join(root, 'a-'));
    b = fs.mkdtempSync(path.join(root, 'b-'));
    fs.writeFileSync(path.join(a, '9201-a-one.md'), '---\ntitle: A1\n---\n\n# Goal\na\n');
    fs.writeFileSync(path.join(a, '9202-a-two.md'), '---\ntitle: A2\n---\n\n# Goal\na\n');
    fs.writeFileSync(path.join(b, '9301-b-one.md'), '---\ntitle: B1\n---\n\n# Goal\nb\n');
    fs.utimesSync(a, 1_000_000_000, 1_000_000_000);
    fs.utimesSync(b, 1_000_000_000, 1_000_000_000);
  });

  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('two folders with identical mtimes each get their own files, in parallel and repeated', async () => {
    expect(fs.statSync(a).mtimeMs).toBe(fs.statSync(b).mtimeMs);
    const want = {
      a: [path.join(a, '9201-a-one.md'), path.join(a, '9202-a-two.md')],
      b: [path.join(b, '9301-b-one.md')],
    };
    for (let pass = 0; pass < 3; pass++) {
      const [la, lb] = await Promise.all([prdParser.listPrdFiles(a), prdParser.listPrdFiles(b)]);
      expect(la).toEqual(want.a);
      expect(lb).toEqual(want.b);
      const [lb2, la2] = await Promise.all([prdParser.listPrdFiles(b), prdParser.listPrdFiles(a)]);
      expect(la2).toEqual(want.a);
      expect(lb2).toEqual(want.b);
    }
  });

  test('a second pass over unchanged folders re-parses no PRD file', async () => {
    const pass = async () => {
      const lists = await Promise.all([prdParser.listPrdFiles(a), prdParser.listPrdFiles(b)]);
      return Promise.all(lists.flat().map((f) => prdParser.parsePrd(f)));
    };
    const first = await pass();
    expect(first.map((p) => p.title)).toEqual(['A1', 'A2', 'B1']);
    const readSpy = vi.spyOn(fsp, 'readFile');
    const readdirSpy = vi.spyOn(fsp, 'readdir');
    const second = await pass();
    expect(second.map((p) => p.title)).toEqual(['A1', 'A2', 'B1']);
    expect(readSpy).not.toHaveBeenCalled();
    expect(readdirSpy).not.toHaveBeenCalled();
  });

  test('pruning drops only vanished entries of the listed folder', async () => {
    const lists = await Promise.all([prdParser.listPrdFiles(a), prdParser.listPrdFiles(b)]);
    await Promise.all(lists.flat().map((f) => prdParser.parsePrd(f)));
    fs.rmSync(path.join(a, '9202-a-two.md'));
    fs.utimesSync(a, 1_000_000_005, 1_000_000_005);
    expect(await prdParser.listPrdFiles(a)).toEqual([path.join(a, '9201-a-one.md')]);
    const readSpy = vi.spyOn(fsp, 'readFile');
    // b's and a's surviving parses are still cached.
    await prdParser.parsePrd(path.join(b, '9301-b-one.md'));
    await prdParser.parsePrd(path.join(a, '9201-a-one.md'));
    expect(readSpy).not.toHaveBeenCalled();
  });
});
