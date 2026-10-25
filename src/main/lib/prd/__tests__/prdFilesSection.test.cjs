'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderFilesSection, parseFilesSection } = require('../prdGateFiles.cjs');
const prdParser = require('../../../scheduler/prdParser.cjs');

test('round-trips the rendered list', () => {
  const files = ['src/a.cjs', 'src/lib/b.cjs', 'docs/x y.md'];
  const body = ['# Goal', '', 'g', '', ...renderFilesSection(files), '# Gate', '', '- not/a/file'].join('\n');
  assert.deepEqual(parseFilesSection(body), files);
});

test('keeps a folder entry ending in /', () => {
  const files = ['src/main/lib/', 'src/a.cjs'];
  assert.deepEqual(parseFilesSection(renderFilesSection(files).join('\n')), files);
});

test('returns [] without a # Files section', () => {
  assert.deepEqual(parseFilesSection('# Goal\n\n- x\n'), []);
  assert.deepEqual(parseFilesSection(''), []);
});

test('parsed PRD exposes files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prdfiles-'));
  const f = path.join(dir, '1-demo.md');
  const body = ['# Goal', '', 'g', '', ...renderFilesSection(['src/a.cjs', 'src/dir/'])].join('\n');
  fs.writeFileSync(f, `---\ntitle: Demo\n---\n${body}\n`);
  prdParser._resetCache();
  const parsed = await prdParser.parsePrdRaw(f);
  assert.deepEqual(parsed.files, ['src/a.cjs', 'src/dir/']);
  fs.rmSync(dir, { recursive: true, force: true });
});
