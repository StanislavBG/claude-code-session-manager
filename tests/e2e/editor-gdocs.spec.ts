/**
 * Editor v0.17 — Google-Docs feel + wide file-type support.
 *
 * Covers the new paths: markdown document outline + split view, CSV → table,
 * binary-file fallback pane, and PDF dispatch. Driven through the same
 * `window.__editor` store handle as editor.spec.ts. Fixtures live under $HOME
 * because files.read + the smfile:// handler enforce home containment.
 */
import { test, expect } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { launchApp } from './_helpers/launchApp'

let dir: string
const files: Record<string, string> = {}

test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.homedir(), '.sm-editor-gdocs-e2e-'))
  files.md = path.join(dir, 'doc.md')
  files.csv = path.join(dir, 'data.csv')
  files.bin = path.join(dir, 'blob.bin')
  files.pdf = path.join(dir, 'paper.pdf')
  fs.writeFileSync(files.md, '# Title\n\nIntro.\n\n## Section A\n\ntext\n\n## Section B\n\nmore\n')
  fs.writeFileSync(files.csv, 'name,age,city\nAda,36,London\nBabbage,79,"Devon, UK"\n')
  // A NUL byte makes readFile classify this as binary.
  fs.writeFileSync(files.bin, Buffer.from([0x00, 0x01, 0x02, 0x42, 0x00, 0xff]))
  // Minimal valid-enough PDF header; dispatch is by extension, not content.
  fs.writeFileSync(files.pdf, '%PDF-1.4\n%%EOF\n')
})

test.afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

async function openInEditor(win: import('@playwright/test').Page, absPath: string) {
  await win.evaluate((p) => {
    const ed = (window as unknown as { __editor: { getState: () => { openFile: (x: string) => void } } }).__editor
    ed.getState().openFile(p)
    window.dispatchEvent(new CustomEvent('sm:open-editor'))
  }, absPath)
}

test('markdown shows a document outline of its headings', async () => {
  const { app, win } = await launchApp()
  try {
    await openInEditor(win, files.md)
    await expect(win.locator('.markdown-body h1', { hasText: 'Title' })).toBeVisible({ timeout: 5000 })
    // Outline panel lists the headings.
    await expect(win.locator('button', { hasText: /^Section A$/ })).toBeVisible({ timeout: 5000 })
    await expect(win.locator('button', { hasText: /^Section B$/ })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('markdown split view shows Monaco and the live preview together', async () => {
  const { app, win } = await launchApp()
  try {
    await openInEditor(win, files.md)
    await expect(win.locator('.markdown-body h1').first()).toBeVisible({ timeout: 5000 })
    // Switch to Split.
    await win.evaluate((p) => {
      const ed = (window as unknown as { __editor: { getState: () => { setViewMode: (a: string, b: string) => void } } }).__editor
      ed.getState().setViewMode(p, 'split')
    }, files.md)
    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 8000 })
    await expect(win.locator('.markdown-body h1', { hasText: 'Title' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('csv renders as a table', async () => {
  const { app, win } = await launchApp()
  try {
    await openInEditor(win, files.csv)
    await expect(win.locator('table thead th', { hasText: /^name$/ })).toBeVisible({ timeout: 5000 })
    // Quoted field with an embedded comma stays one cell.
    await expect(win.locator('table td', { hasText: 'Devon, UK' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('binary file shows the fallback pane, not garbled text', async () => {
  const { app, win } = await launchApp()
  try {
    await openInEditor(win, files.bin)
    await expect(win.locator('text=Open in default app')).toBeVisible({ timeout: 5000 })
    await expect(win.locator('.monaco-editor')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('pdf dispatches to the smfile iframe viewer', async () => {
  const { app, win } = await launchApp()
  try {
    await openInEditor(win, files.pdf)
    await expect(win.locator('iframe[src^="smfile://"]')).toBeVisible({ timeout: 5000 })
  } finally {
    await app.close()
  }
})
