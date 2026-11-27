import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Returns dist-web/app.css text, rebuilding first when it is missing or older than the sources that
// feed Tailwind (src/renderer .ts/.tsx/.css, tailwind/postcss configs, vite.web.config.ts).
// Unit-tested by tests/unit/web-css-fresh.spec.ts.

const MAX_FILES = 20000
const SRC_EXT = /\.(ts|tsx|css)$/

function newestSourceMtime(root: string, maxFiles: number): number {
  let newest = 0
  let seen = 0
  const bump = (file: string) => {
    if (++seen > maxFiles) throw new Error(`webCss: source walk exceeded the ${maxFiles}-file cap`)
    newest = Math.max(newest, fs.statSync(file).mtimeMs)
  }
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__tests__') continue
        walk(full)
      } else if (e.isFile() && SRC_EXT.test(e.name)) bump(full)
    }
  }
  walk(path.join(root, 'src/renderer'))
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isFile() && (/^(tailwind|postcss)\.config\./.test(e.name) || e.name === 'vite.web.config.ts')) bump(path.join(root, e.name))
  }
  return newest
}

export function ensureWebCss(root: string, deps: { build?: () => void; maxFiles?: number } = {}): string {
  const build = deps.build ?? (() => { execSync('npx vite build --config vite.web.config.ts', { cwd: root, stdio: 'inherit' }) })
  const cssPath = path.join(root, 'dist-web/app.css')
  const stale = !fs.existsSync(cssPath) || fs.statSync(cssPath).mtimeMs < newestSourceMtime(root, deps.maxFiles ?? MAX_FILES)
  if (stale) build()
  return fs.readFileSync(cssPath, 'utf8')
}
