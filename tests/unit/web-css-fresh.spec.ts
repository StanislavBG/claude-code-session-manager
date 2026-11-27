import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureWebCss } from '../web-ui/webCss.ts'

let root: string
const at = (rel: string, sec: number) => {
  const t = new Date(sec * 1000)
  fs.utimesSync(path.join(root, rel), t, t)
}
const write = (rel: string, body: string, sec: number) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), body)
  at(rel, sec)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-css-'))
  write('src/renderer/a.tsx', 'x', 1000)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('ensureWebCss', () => {
  it('builds when the CSS is missing', () => {
    let builds = 0
    const text = ensureWebCss(root, { build: () => { builds++; write('dist-web/app.css', 'built', 2000) } })
    expect(builds).toBe(1)
    expect(text).toBe('built')
  })
  it('builds when the CSS is older than a source', () => {
    write('dist-web/app.css', 'old', 500)
    let builds = 0
    const text = ensureWebCss(root, { build: () => { builds++; write('dist-web/app.css', 'new', 2000) } })
    expect(builds).toBe(1)
    expect(text).toBe('new')
  })
  it('does not build when the CSS is fresh, and returns its text', () => {
    write('dist-web/app.css', 'fresh-css', 2000)
    write('src/renderer/__tests__/t.ts', 'x', 9000)
    write('node_modules/p/i.ts', 'x', 9000)
    let builds = 0
    expect(ensureWebCss(root, { build: () => { builds++ } })).toBe('fresh-css')
    expect(builds).toBe(0)
  })
  it('treats a newer config file as stale', () => {
    write('dist-web/app.css', 'c', 2000)
    write('tailwind.config.js', 'x', 3000)
    let builds = 0
    ensureWebCss(root, { build: () => { builds++ } })
    expect(builds).toBe(1)
  })
})
