/**
 * stage.cjs — stage the shipped files into release/stage/ for electron-builder.
 *
 * electron-builder refuses an app whose package.json lists `electron` in
 * dependencies, but the npx distribution needs it there. So the packaged app
 * is a second tree (directories.app = release/stage) with a rewritten
 * package.json and its own production node_modules.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REMOVED_DEPS = ['electron', '@electron/rebuild'];
// Read at runtime by src/main/lib/modelCatalog.cjs but not in package.json `files`.
const EXTRA_PATHS = ['src/renderer/data/'];

function stagePackageJson(rootPkg) {
  const out = JSON.parse(JSON.stringify(rootPkg));
  const deps = { ...(out.dependencies || {}) };
  for (const name of REMOVED_DEPS) delete deps[name];
  out.dependencies = deps;
  delete out.devDependencies;
  delete out.os;
  out.scripts = {};
  return out;
}

// Node refuses to spawn .cmd shims without a shell (EINVAL), so run npm's JS
// entry point with the current node binary instead.
function npmInvocation(env, platform) {
  const execpath = env.npm_execpath;
  if (execpath && /\.c?js$/.test(execpath)) {
    return { command: process.execPath, args: [execpath] };
  }
  if (platform === 'win32') {
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return { command: process.execPath, args: [cli] };
  }
  return { command: 'npm', args: [] };
}

function main() {
  const root = path.resolve(__dirname, '..', '..');
  const stage = path.join(root, 'release', 'stage');
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  const entries = rootPkg.files.filter((f) => !f.startsWith('!')).concat(EXTRA_PATHS);
  const filter = (src) => !src.split(path.sep).includes('__tests__');
  for (const entry of entries) {
    const rel = entry.replace(/\/+$/, '');
    const from = path.join(root, rel);
    if (!fs.existsSync(from)) throw new Error(`stage: missing shipped path ${entry}`);
    const to = path.join(stage, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, filter });
  }

  fs.writeFileSync(
    path.join(stage, 'package.json'),
    JSON.stringify(stagePackageJson(rootPkg), null, 2) + '\n',
  );

  const npm = npmInvocation(process.env, process.platform);
  const installArgs = ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
  execFileSync(npm.command, [...npm.args, ...installArgs], {
    cwd: stage,
    stdio: 'inherit',
  });
  console.log(`staged ${stage}`);
}

module.exports = { stagePackageJson, npmInvocation };

if (require.main === module) main();
