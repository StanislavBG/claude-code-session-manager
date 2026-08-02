// bilkoHost.cjs — integration test against a real temp project dir: adding
// and removing documents, and that Prepare Bundle wholesale-rebuilds dist/
// so a removed document can never linger on disk (the local half of the
// "delete propagates on next Publish" guarantee — see bilkoHost-integration.md).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const config = require('../config.cjs');
const bilkoHost = require('../bilkoHost.cjs');

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bilko-host-'));
  config.addAllowedRoot(root);
  fs.mkdirSync(path.join(root, 'session-manager-operations', 'project-pages', 'output'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'session-manager-operations', 'project-pages', 'output', 'marketing.html'),
    '<html><title>Demo</title>Marketing</html>',
  );
  fs.writeFileSync(
    path.join(root, 'session-manager-operations', 'project-pages', 'output', 'feature.html'),
    '<html><title>Demo</title>Feature</html>',
  );
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo-app', version: '1.2.3' }));
  return root;
}

test('prepareBundle seeds a root document and writes dist/index.html + manifest.json', async () => {
  const root = makeProject();
  const result = await bilkoHost.prepareBundle({ cwd: root, slug: 'demo-app' });
  assert.equal(fs.existsSync(path.join(result.distPath, 'index.html')), true);
  assert.equal(fs.readFileSync(path.join(result.distPath, 'index.html'), 'utf8'), '<html><title>Demo</title>Marketing</html>');
  assert.equal(result.manifest.slug, 'demo-app');
  assert.equal(result.manifest.bundle.fileCount, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('addDocument then prepareBundle writes a sub-path document at the expected location', async () => {
  const root = makeProject();
  await bilkoHost.prepareBundle({ cwd: root, slug: 'demo-app' });
  await bilkoHost.addDocument({
    cwd: root,
    subpath: 'special-doc/01',
    title: 'Feature deep-dive',
    source: { kind: 'project-page-lens', lens: 'feature' },
  });
  const result = await bilkoHost.prepareBundle({ cwd: root, slug: 'demo-app' });
  assert.equal(
    fs.readFileSync(path.join(result.distPath, 'special-doc', '01', 'index.html'), 'utf8'),
    '<html><title>Demo</title>Feature</html>',
  );
  assert.equal(result.manifest.bundle.fileCount, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('removeDocument + prepareBundle wholesale-rebuilds dist/, leaving no trace of the removed file', async () => {
  const root = makeProject();
  await bilkoHost.prepareBundle({ cwd: root, slug: 'demo-app' });
  const added = await bilkoHost.addDocument({
    cwd: root,
    subpath: 'special-doc/01',
    title: 'Feature deep-dive',
    source: { kind: 'project-page-lens', lens: 'feature' },
  });
  await bilkoHost.prepareBundle({ cwd: root, slug: 'demo-app' });
  const docId = added.documents.find((d) => d.subpath === 'special-doc/01').id;

  await bilkoHost.removeDocument({ cwd: root, id: docId });
  // Not yet rebuilt — the stale file is still on disk (get() should flag this via bundleStale).
  const distBefore = await bilkoHost.get({ cwd: root });
  assert.equal(distBefore.bundleStale, true);

  const result = await bilkoHost.prepareBundle({ cwd: root, slug: 'demo-app' });
  assert.equal(fs.existsSync(path.join(result.distPath, 'special-doc')), false);
  assert.equal(result.manifest.bundle.fileCount, 1);

  const after = await bilkoHost.get({ cwd: root });
  assert.equal(after.bundleStale, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('removeDocument refuses to remove the root document', async () => {
  const root = makeProject();
  await bilkoHost.prepareBundle({ cwd: root, slug: 'demo-app' });
  const before = await bilkoHost.get({ cwd: root });
  const rootId = before.documents.find((d) => d.subpath === '').id;
  await assert.rejects(() => bilkoHost.removeDocument({ cwd: root, id: rootId }), /cannot remove the root document/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('addDocument refuses a duplicate sub-path', async () => {
  const root = makeProject();
  await bilkoHost.prepareBundle({ cwd: root, slug: 'demo-app' });
  await bilkoHost.addDocument({
    cwd: root,
    subpath: 'doc',
    title: 'A',
    source: { kind: 'project-page-lens', lens: 'feature' },
  });
  await assert.rejects(
    () => bilkoHost.addDocument({ cwd: root, subpath: 'doc', title: 'B', source: { kind: 'project-page-lens', lens: 'feature' } }),
    /already uses subpath/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});
