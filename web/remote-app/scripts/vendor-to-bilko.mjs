// Copies the built dist/ into the Bilko static-path directory. Never commits or pushes that repo.
import { cp, rm, stat, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function countFiles(dir) {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? await countFiles(join(dir, e.name)) : 1;
  }
  return n;
}

export async function vendorBundle({ distDir, targetDir }) {
  for (const f of ['index.html', 'manifest.json']) {
    if (!(await exists(join(distDir, f)))) throw new Error(`vendor-to-bilko: missing ${join(distDir, f)} (run npm run build)`);
  }
  if (!(await exists(dirname(resolve(targetDir))))) {
    throw new Error(`vendor-to-bilko: target parent does not exist: ${dirname(resolve(targetDir))}`);
  }
  await rm(join(targetDir, 'assets'), { recursive: true, force: true });
  await cp(distDir, targetDir, { recursive: true });
  return { copied: await countFiles(distDir) };
}

function parseArgs(argv) {
  const opts = {
    target: join(homedir(), 'Projects', 'Bilko', 'public', 'projects', 'session-manager'),
    dist: join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && argv[i + 1]) opts.target = argv[++i];
    else if (argv[i] === '--dist' && argv[i + 1]) opts.dist = argv[++i];
    else throw new Error(`vendor-to-bilko: unknown argument ${argv[i]}`);
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { target, dist } = parseArgs(process.argv.slice(2));
    const { copied } = await vendorBundle({ distDir: dist, targetDir: target });
    const html = await readFile(join(target, 'index.html'), 'utf8');
    const hash = /src="[^"]*\/(index-[^"/]+\.js)"/.exec(html)?.[1] ?? 'unknown';
    console.log(`vendored ${copied} files to ${target} (script ${hash})`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
