/**
 * In-app Editor scene — open / preview / edit / save + HTML sandbox.
 *
 * The Editor is launched from the Files sidebar and terminal links, neither of
 * which needs a live Claude session here. We drive it through a window test
 * handle (`window.__editor` → the useEditor store), then assert the rendered
 * DOM. Fixtures live UNDER $HOME because both files.read and the smfile://
 * handler enforce home containment.
 */
import { test, expect } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { launchApp } from './_helpers/launchApp'

let dir: string
const files: Record<string, string> = {}

const FRONTMATTER = '---\ntitle: Frontmatter fixture\ntags: [a, b]\n---\n'

test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.homedir(), '.sm-editor-e2e-'))
  files.md = path.join(dir, 'note.md')
  files.mdFrontmatter = path.join(dir, 'with-frontmatter.md')
  files.ts = path.join(dir, 'data.ts')
  files.html = path.join(dir, 'viz.html')
  fs.writeFileSync(files.md, '# Hello Editor\n\nA **bold** idea and a list:\n\n- one\n- two\n')
  fs.writeFileSync(files.mdFrontmatter, `${FRONTMATTER}# Doc\n\nSome body text.\n`)
  fs.writeFileSync(files.ts, 'export const x: number = 1\n')
  fs.writeFileSync(
    files.html,
    '<!doctype html><html><body><h1 id="viz">Chart</h1>' +
      '<script>document.getElementById("viz").textContent = "drawn:" + (2+2)</script>' +
      '</body></html>\n',
  )
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

test('markdown opens rendered, with a tab', async () => {
  const { app, win } = await launchApp()
  try {
    await openInEditor(win, files.md)
    // Tab strip shows the file.
    await expect(win.locator('text=note.md').first()).toBeVisible({ timeout: 5000 })
    // Default view for .md is Preview → marked renders the H1.
    await expect(win.locator('.markdown-body h1', { hasText: 'Hello Editor' })).toBeVisible({ timeout: 5000 })
    // Strong text survived sanitization.
    await expect(win.locator('.markdown-body strong', { hasText: 'bold' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('markdown Wysiwyg mode renders Tiptap and preserves frontmatter untouched', async () => {
  const { app, win } = await launchApp()
  try {
    await openInEditor(win, files.mdFrontmatter)
    await expect(win.locator('text=with-frontmatter.md').first()).toBeVisible({ timeout: 5000 })

    // The view-mode toggle for markdown includes Wysiwyg alongside Edit/Preview/Split.
    const wysiwygBtn = win.locator('button', { hasText: /^wysiwyg$/i })
    await expect(wysiwygBtn).toBeVisible({ timeout: 5000 })

    // Switch via the store directly for determinism (avoids click/viewport timing).
    await win.evaluate((p) => {
      const ed = (window as unknown as { __editor: { getState: () => { setViewMode: (a: string, b: string) => void } } }).__editor
      ed.getState().setViewMode(p, 'wysiwyg')
    }, files.mdFrontmatter)

    await expect(win.locator('[data-testid="tiptap-editor"]')).toBeVisible({ timeout: 5000 })

    // Opening into Wysiwyg without editing must leave the frontmatter block
    // byte-identical in the buffer — TiptapBody never lets Tiptap see it.
    const buffer = await win.evaluate((p) => {
      const ed = (window as unknown as { __editor: { getState: () => { buffers: Record<string, string> } } }).__editor
      return ed.getState().buffers[p]
    }, files.mdFrontmatter)
    expect(buffer?.startsWith(FRONTMATTER)).toBe(true)
  } finally {
    await app.close()
  }
})

test('html preview runs in a sandboxed iframe without allow-same-origin', async () => {
  const { app, win } = await launchApp()
  try {
    await openInEditor(win, files.html)
    const iframe = win.locator('iframe[src^="smfile://"]')
    await expect(iframe).toBeVisible({ timeout: 5000 })
    const sandbox = await iframe.getAttribute('sandbox')
    expect(sandbox).toBeTruthy()
    expect(sandbox).toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')
  } finally {
    await app.close()
  }
})

test('code file opens in Monaco edit mode with no preview toggle', async () => {
  const { app, win } = await launchApp()
  try {
    await openInEditor(win, files.ts)
    // Monaco mounts.
    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 8000 })
    // No Edit/Preview toggle for non-renderable types.
    await expect(win.locator('button', { hasText: /^Preview$/ })).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('editing marks dirty; Ctrl-S saves to disk and clears dirty', async () => {
  const { app, win } = await launchApp()
  try {
    await openInEditor(win, files.ts)
    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 8000 })
    // Drive an edit through the store (controlled Monaco picks it up).
    await win.evaluate((p) => {
      const ed = (window as unknown as { __editor: { getState: () => { setBuffer: (a: string, b: string) => void; setActive: (a: string) => void } } }).__editor
      ed.getState().setActive(p)
      ed.getState().setBuffer(p, 'export const x: number = 42\n')
    }, files.ts)
    // Dirty dot appears in the tab strip.
    const dirty = await win.evaluate((p) => {
      const ed = (window as unknown as { __editor: { getState: () => { dirty: Record<string, boolean> } } }).__editor
      return ed.getState().dirty[p] === true
    }, files.ts)
    expect(dirty).toBe(true)
    // Save via the scene shortcut — the listener is on window, so dispatch the
    // keydown there directly (no element focus needed).
    await win.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })))
    await win.waitForTimeout(600)
    // On-disk content changed and dirty cleared.
    const onDisk = fs.readFileSync(files.ts, 'utf8')
    expect(onDisk).toContain('= 42')
    const stillDirty = await win.evaluate((p) => {
      const ed = (window as unknown as { __editor: { getState: () => { dirty: Record<string, boolean> } } }).__editor
      return ed.getState().dirty[p] === true
    }, files.ts)
    expect(stillDirty).toBe(false)
  } finally {
    await app.close()
  }
})
