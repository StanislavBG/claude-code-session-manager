'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seedAuthoringGuide } = require('../lib/prdAuthoringSeed.cjs');

const write = async (abs, text) => fs.writeFileSync(abs, text, 'utf8');

describe('seedAuthoringGuide', () => {
  let dir, src, dest;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prd-seed-'));
    src = path.join(dir, 'src.md');
    dest = path.join(dir, 'dest.md');
    fs.writeFileSync(src, '<!-- PRD_AUTHORING.md v3 -->\nnew body\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('seeds an absent destination', async () => {
    expect(await seedAuthoringGuide({ src, dest, write })).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toContain('new body');
  });
  it('overwrites a stale stamp', async () => {
    fs.writeFileSync(dest, '<!-- PRD_AUTHORING.md v2 -->\nold\n');
    expect(await seedAuthoringGuide({ src, dest, write })).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toContain('v3');
  });
  it('leaves a matching stamp untouched', async () => {
    const same = '<!-- PRD_AUTHORING.md v3 -->\nlocal edit\n';
    fs.writeFileSync(dest, same);
    expect(await seedAuthoringGuide({ src, dest, write })).toBe(false);
    expect(fs.readFileSync(dest, 'utf8')).toBe(same);
  });
  it('overwrites a destination with no stamp', async () => {
    fs.writeFileSync(dest, '# no stamp\n');
    expect(await seedAuthoringGuide({ src, dest, write })).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toContain('v3');
  });
});
