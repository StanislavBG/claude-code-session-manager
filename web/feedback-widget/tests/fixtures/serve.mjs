// Tiny static server for the Playwright e2e fixtures. Serves tests/fixtures/ and an
// on-the-fly IIFE bundle of src/capture.ts at /capture.js (window.__capture).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4179);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

const bundled = await build({
  stdin: {
    contents: "import { captureViewport } from './src/capture.ts'; window.__capture = captureViewport;",
    resolveDir: join(here, '..', '..'),
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  write: false,
  target: 'es2020',
});
const captureJs = bundled.outputFiles[0].text;

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path === '/capture.js') {
    res.writeHead(200, { 'content-type': types['.js'] });
    res.end(captureJs);
    return;
  }
  const file = normalize(join(here, path === '/' ? 'capture.html' : path));
  if (!file.startsWith(here)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`fixtures on http://127.0.0.1:${port}`));
