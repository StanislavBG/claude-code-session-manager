// Tiny static server for the Playwright e2e fixtures. Serves tests/fixtures/ and an
// on-the-fly IIFE bundle of src/capture.ts at /capture.js (window.__capture).
// /fonts/<file>.woff2 serves @fontsource files (fonts.e2e.ts); /fonts/fw-test-serif.css is an
// @font-face sheet for them. A second listener on PORT+1 serves the same routes with
// Access-Control-Allow-Origin: * — the cross-origin font host.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4179);
const types = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.woff2': 'font/woff2',
};
const fontDirs = ['jetbrains-mono', 'source-serif-4'].map((pkg) =>
  join(here, '..', '..', 'node_modules', '@fontsource', pkg, 'files'),
);
const FONT_FILE = /^\/fonts\/([A-Za-z0-9][A-Za-z0-9._-]*\.woff2)$/;
const serifCss = `@font-face {
  font-family: 'FW Test Serif';
  font-style: normal;
  font-weight: 400;
  src: url('source-serif-4-latin-400-normal.woff2') format('woff2');
}
`;

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

async function serveFont(file, res, extra) {
  for (const dir of fontDirs) {
    try {
      const body = await readFile(join(dir, file));
      res.writeHead(200, { ...extra, 'content-type': types['.woff2'] });
      res.end(body);
      return;
    } catch {
      // not in this package — try the next
    }
  }
  res.writeHead(404, extra).end('not found');
}

const handler = (extra) => async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path === '/capture.js') {
    res.writeHead(200, { ...extra, 'content-type': types['.js'] });
    res.end(captureJs);
    return;
  }
  if (path === '/fonts/fw-test-serif.css') {
    res.writeHead(200, { ...extra, 'content-type': types['.css'] });
    res.end(serifCss);
    return;
  }
  if (path.startsWith('/fonts/')) {
    const m = FONT_FILE.exec(path);
    if (!m || m[1].includes('..')) {
      res.writeHead(404, extra).end('not found');
      return;
    }
    await serveFont(m[1], res, extra);
    return;
  }
  const file = normalize(join(here, path === '/' ? 'capture.html' : path));
  if (!file.startsWith(here)) {
    res.writeHead(403, extra).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...extra, 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, extra).end('not found');
  }
};

createServer(handler({})).listen(port, '127.0.0.1', () =>
  console.log(`fixtures on http://127.0.0.1:${port}`),
);
createServer(handler({ 'access-control-allow-origin': '*' })).listen(port + 1, '127.0.0.1', () =>
  console.log(`cross-origin fixtures on http://127.0.0.1:${port + 1}`),
);
