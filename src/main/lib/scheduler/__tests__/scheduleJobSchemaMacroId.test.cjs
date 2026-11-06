'use strict';
import { describe, it, expect } from 'vitest';
const { assertValidScheduleJob } = require('../scheduleJobSchema.cjs');
const prdParser = require('../../../scheduler/prdParser.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('ScheduleJob macroId', () => {
  it('keeps a string macroId', () => {
    expect(assertValidScheduleJob({ slug: 'a', status: 'pending', macroId: 'demo-video' }).macroId).toBe('demo-video');
  });
  it('accepts null and absent', () => {
    expect(assertValidScheduleJob({ slug: 'a', status: 'pending', macroId: null }).macroId).toBeNull();
    expect(assertValidScheduleJob({ slug: 'a', status: 'pending' }).macroId).toBeUndefined();
  });
  it('rejects a non-string macroId', () => {
    expect(() => assertValidScheduleJob({ slug: 'a', status: 'pending', macroId: 5 })).toThrow(/macroId/);
  });
  it('scheduler parsePrd surfaces macroId from frontmatter', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macroid-'));
    const f = path.join(dir, '01-x.md');
    fs.writeFileSync(f, '---\ntitle: X\ncwd: /tmp\nmacroId: demo-video\n---\n# Goal\nx\n');
    const g = path.join(dir, '02-y.md');
    fs.writeFileSync(g, '---\ntitle: Y\ncwd: /tmp\n---\n# Goal\nx\n');
    expect((await prdParser.parsePrd(f)).macroId).toBe('demo-video');
    expect((await prdParser.parsePrd(g)).macroId).toBeNull();
  });
});
