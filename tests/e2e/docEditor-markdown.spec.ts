/**
 * Doc Editor — WYSIWYG markdown mode (PRD 06) acceptance criteria.
 *
 * Focus: frontmatter round-trip integrity and mode-toggle UI.
 *
 * Note: Full Tiptap rendering cannot be easily tested headlessly (Electron
 * renderer). Tests cover the store layer (mode persistence, frontmatter
 * splitting) and the DOM toggle buttons. The byte-identical round-trip check
 * is done at the unit layer (tests/unit/markdownDoc.spec.ts) and via the
 * store's bufferText (which TiptapBody writes back via onChange).
 */
import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import type { Page } from 'playwright-core'
import { launchApp, navigateToTab, ROOT } from './_helpers/launchApp'

const TMP_DIR = path.join(os.homedir(), '.config', 'session-manager', 'e2e-md-tmp')
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'doc-editor')

const PATHS = {
  prd: path.join(TMP_DIR, 'prd-with-frontmatter.md'),
  readme: path.join(TMP_DIR, 'readme.md'),
}

test.beforeAll(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true })
  const [prd, readme] = await Promise.all([
    fs.readFile(path.join(FIXTURE_DIR, 'prd-with-frontmatter.md'), 'utf8'),
    fs.readFile(path.join(FIXTURE_DIR, 'readme.md'), 'utf8'),
  ])
  await Promise.all([
    fs.writeFile(PATHS.prd, prd),
    fs.writeFile(PATHS.readme, readme),
  ])
})

test.afterAll(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true })
  // Clean up persisted doc-editor state.
  try {
    const cfgPath = path.join(os.homedir(), '.config', 'session-manager', 'doc-editor.json')
    const raw = await fs.readFile(cfgPath, 'utf8').catch(() => '{}')
    const cfg = JSON.parse(raw)
    delete cfg.openPaths
    delete cfg.viewModes
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
  } catch { /* best-effort */ }
})

async function openDocViaEval(win: Page, filePath: string) {
  await win.evaluate(async (p: string) => {
    await (window as unknown as Record<string, { getState: () => { open: (p: string) => Promise<void> } }>).__docEditor.getState().open(p)
  }, filePath)
}

async function getStoreViewMode(win: Page, p: string): Promise<string | null> {
  return win.evaluate((path) => {
    const store = (window as unknown as { __docEditor: { getState: () => { viewModes: Record<string, string> } } }).__docEditor
    return store.getState().viewModes[path] ?? null
  }, p)
}

async function storeBufferText(win: Page, p: string): Promise<string | null> {
  return win.evaluate((path) => {
    const store = (window as unknown as { __docEditor: { getState: () => { docs: Record<string, { bufferText: string }> } } }).__docEditor
    return store.getState().docs[path]?.bufferText ?? null
  }, p)
}

test('mode toggle renders for .md files', async () => {
  const { app, win, errors } = await launchApp()
  try {
    await navigateToTab(win, 'doc-editor')
    await win.waitForSelector('[data-testid="doc-editor-panel"], h1', { timeout: 8_000 })

    await openDocViaEval(win, PATHS.readme)
    await win.waitForSelector('[data-testid="doc-tab-strip"]', { timeout: 5_000 })

    // WYSIWYG/Source toggle should be visible for .md files.
    const toggle = win.locator('[data-testid="view-mode-toggle"]')
    await expect(toggle).toBeVisible({ timeout: 5_000 })

    const wysiwyg = win.locator('[data-testid="view-mode-wysiwyg"]')
    const source = win.locator('[data-testid="view-mode-source"]')
    await expect(wysiwyg).toBeVisible()
    await expect(source).toBeVisible()

    // Default mode is WYSIWYG.
    await expect(wysiwyg).toHaveClass(/bg-accent/)

    const realErrors = errors.filter((e) =>
      !e.includes('favicon') &&
      !e.includes('apiBootCheck') &&
      !/Autofill\.enable|Autofill\.setAddresses/.test(e)
    )
    expect(realErrors).toHaveLength(0)
  } finally {
    await app.close()
  }
})

test('mode toggle stores and restores source selection', async () => {
  const { app, win, errors } = await launchApp()
  try {
    await navigateToTab(win, 'doc-editor')
    await win.waitForSelector('[data-testid="doc-editor-panel"], h1', { timeout: 8_000 })

    await openDocViaEval(win, PATHS.readme)
    await win.waitForSelector('[data-testid="view-mode-toggle"]', { timeout: 5_000 })

    // Set view mode via store directly (avoids viewport/click timing issues in headless).
    await win.evaluate((p: string) => {
      const store = (window as unknown as { __docEditor: { getState: () => { setViewMode: (p: string, m: string) => void } } }).__docEditor
      store.getState().setViewMode(p, 'source')
    }, PATHS.readme)
    await win.waitForTimeout(200)

    // Store should now reflect 'source' for this path.
    const mode = await getStoreViewMode(win, PATHS.readme)
    expect(mode).toBe('source')

    // Source button should be highlighted.
    const source = win.locator('[data-testid="view-mode-source"]')
    await expect(source).toHaveClass(/bg-accent/, { timeout: 3_000 })

    const realErrors = errors.filter((e) =>
      !e.includes('favicon') &&
      !e.includes('apiBootCheck') &&
      !/Autofill\.enable|Autofill\.setAddresses/.test(e)
    )
    expect(realErrors).toHaveLength(0)
  } finally {
    await app.close()
  }
})

test('frontmatter preserved after WYSIWYG open without editing', async () => {
  // This is the critical round-trip safety check from the PRD.
  // We open a file with frontmatter, check the store holds the original content,
  // then verify the frontmatter block is verbatim in the buffer.
  const originalContent = await fs.readFile(PATHS.prd, 'utf8')
  const fmMatch = originalContent.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/)
  const originalFrontmatter = fmMatch ? fmMatch[1] : null
  expect(originalFrontmatter).toBeTruthy()

  const { app, win, errors } = await launchApp()
  try {
    await navigateToTab(win, 'doc-editor')
    await win.waitForSelector('[data-testid="doc-editor-panel"], h1', { timeout: 8_000 })

    await openDocViaEval(win, PATHS.prd)
    await win.waitForSelector('[data-testid="view-mode-toggle"]', { timeout: 5_000 })
    await win.waitForTimeout(500)

    // On open, the store's bufferText should be the original file content
    // (Tiptap hasn't emitted an update yet since the user hasn't typed).
    const bufferText = await storeBufferText(win, PATHS.prd)
    expect(bufferText).not.toBeNull()

    // The frontmatter block must be byte-identical in the buffer.
    // Tiptap should not have touched it because TiptapBody splits it off.
    if (bufferText && originalFrontmatter) {
      expect(bufferText.startsWith(originalFrontmatter)).toBe(true)
    }

    const realErrors = errors.filter((e) =>
      !e.includes('favicon') &&
      !e.includes('apiBootCheck') &&
      !/Autofill\.enable|Autofill\.setAddresses/.test(e)
    )
    expect(realErrors).toHaveLength(0)
  } finally {
    await app.close()
  }
})

test('non-.md files do not show mode toggle', async () => {
  // Create a .txt fixture in the temp dir.
  const txtPath = path.join(TMP_DIR, 'notes.txt')
  await fs.writeFile(txtPath, 'plain text content\n')

  const { app, win, errors } = await launchApp()
  try {
    await navigateToTab(win, 'doc-editor')
    await win.waitForSelector('[data-testid="doc-editor-panel"], h1', { timeout: 8_000 })

    await openDocViaEval(win, txtPath)
    await win.waitForSelector('[data-testid="doc-tab-strip"]', { timeout: 5_000 })
    await win.waitForTimeout(300)

    // No mode toggle for .txt files.
    const toggle = win.locator('[data-testid="view-mode-toggle"]')
    await expect(toggle).not.toBeVisible({ timeout: 2_000 })

    // Textarea should be visible instead.
    const textarea = win.locator('[data-testid="doc-textarea"]')
    await expect(textarea).toBeVisible({ timeout: 3_000 })

    const realErrors = errors.filter((e) =>
      !e.includes('favicon') &&
      !e.includes('apiBootCheck') &&
      !/Autofill\.enable|Autofill\.setAddresses/.test(e)
    )
    expect(realErrors).toHaveLength(0)
  } finally {
    await app.close()
  }
})
