#!/usr/bin/env node
// serve.mjs — tiny static server for the promo (fonts + fetch() need http://, not file://).
// Usage: node serve.mjs [port]   → open the printed URL for the live player.
import http from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.wav': 'audio/wav',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
}

export function serve(port = 0, root = ROOT) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const file = normalize(join(root, url === '/' ? '/index.html' : url))
    if (!file.startsWith(resolve(root))) {
      res.writeHead(403).end()
      return
    }
    let st
    try {
      st = statSync(file)
    } catch {
      res.writeHead(404).end('not found')
      return
    }
    if (st.isDirectory()) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' })
    createReadStream(file).pipe(res)
  })
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ port: server.address().port, close: () => server.close() })))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await serve(Number(process.argv[2]) || 8765)
  console.log(`Session Manager promo → http://127.0.0.1:${port}/`)
}
