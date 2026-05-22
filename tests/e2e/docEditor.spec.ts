/**
 * Doc Editor e2e spec — PRD 03/04/05 acceptance criteria.
 *
 * PRD 05 note: .md and .json files now use Monaco; .txt still uses the
 * plain textarea. Tests that interact with editor content use the store
 * (via window.__docEditor) for Monaco-backed files and the DOM for textarea.
 */
import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import type { Page } from 'playwright-core'
import { launchApp, navigateToTab, ROOT } from './_helpers/launchApp'

const TMP_DIR = path.join(os.homedir(), '.config', 'session-manager', 'e2e-doc-tmp')
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'doc-editor')
const PATHS = {
  readme: path.join(TMP_DIR, 'readme.md'),
  settings: path.join(TMP_DIR, 'settings.json'),
  notes: path.join(TMP_DIR, 'notes.txt'),
}

test.beforeAll(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true })
  const [a, b, c] = await Promise.all([
    fs.readFile(path.join(FIXTURE_DIR, 'readme.md'), 'utf8'),
    fs.readFile(path.join(FIXTURE_DIR, 'settings.json'), 'utf8'),
    fs.readFile(path.join(FIXTURE_DIR, 'notes.txt'), 'utf8'),
  ])
  await Promise.all([
    fs.writeFile(PATHS.readme, a),
    fs.writeFile(PATHS.settings, b),
    fs.writeFile(PATHS.notes, c),
  ])
})

// Wipe openPaths before each test so hydration from prior tests doesn't bleed through.
test.beforeEach(async () => {
  try {
    const cfgPath = path.join(os.homedir(), '.config', 'session-manager', 'doc-editor.json')
    const raw = await fs.readFile(cfgPath, 'utf8').catch(() => '{}')
    const cfg = JSON.parse(raw)
    delete cfg.openPaths
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
  } catch { /* best-effort */ }
})

test.afterAll(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true })
  // Clean up persisted doc-editor state so it does not bleed into other test runs.
  try {
    const cfgPath = path.join(os.homedir(), '.config', 'session-manager', 'doc-editor.json')
    const raw = await fs.readFile(cfgPath, 'utf8').catch(() => '{}')
    const cfg = JSON.parse(raw)
    delete cfg.openPaths
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
  } catch { /* best-effort */ }
})

async function openDocViaEval(win: Page, filePath: string) {
  await win.evaluate(async (p: string) => {
    await (window as unknown as Record<string, { getState: () => { open: (p: string) => Promise<void> } }>).__docEditor.getState().open(p)
  }, filePath)
  // Let React render and the 150ms transition-colors on tab active state settle.
  await win.waitForTimeout(200)
}

/** Read bufferText from the store for a given path. */
async function storeBufferText(win: Page, p: string): Promise<string | null> {
  return win.evaluate((path) => {
    const store = (window as unknown as { __docEditor: { getState: () => { docs: Record<string, { bufferText: string }> } } }).__docEditor
    return store.getState().docs[path]?.bufferText ?? null
  }, p)
}

/** Trigger store.edit() directly (used for Monaco-backed files where textarea doesn't exist). */
async function storeEdit(win: Page, p: string, text: string): Promise<void> {
  await win.evaluate(({ path, t }: { path: string; t: string }) => {
    const store = (window as unknown as { __docEditor: { getState: () => { edit: (p: string, t: string) => void } } }).__docEditor
    store.getState().edit(path, t)
  }, { path: p, t: text })
}

test('three files open as sub-tabs', async () => {
  const { app, win, errors } = await launchApp()
  try {
    await navigateToTab(win, 'doc-editor')
    // Store is hydrated on mount — wait for empty state to appear first.
    await win.waitForSelector('[data-testid="doc-editor-panel"], [class*="EmptyState"], h1', { timeout: 8_000 })

    // Open three files via store (bypasses native dialog).
    await openDocViaEval(win, PATHS.readme)
    await openDocViaEval(win, PATHS.settings)
    await openDocViaEval(win, PATHS.notes)

    // Three sub-tabs must render.
    await expect(win.locator('[data-testid="doc-tab-strip"] > [data-testid^="doc-tab-"]:not([data-testid^="doc-tab-close-"])')).toHaveCount(3, { timeout: 5_000 })

    const real = errors.filter((e) => !/Autofill\.enable|Autofill\.setAddresses/.test(e))
    expect(real, `renderer errors: ${real.join(' | ')}`).toEqual([])
  } finally {
    await app.close()
  }
})

test('clicking each tab shows correct content', async () => {
  const { app, win } = await launchApp()
  try {
    await navigateToTab(win, 'doc-editor')
    await win.waitForTimeout(300)

    await openDocViaEval(win, PATHS.readme)
    await openDocViaEval(win, PATHS.settings)
    await openDocViaEval(win, PATHS.notes)

    const readmeContent = await fs.readFile(PATHS.readme, 'utf8')
    const settingsContent = await fs.readFile(PATHS.settings, 'utf8')
    const notesContent = await fs.readFile(PATHS.notes, 'utf8')

    // readme.md uses TiptapBody (wysiwyg); settings.json uses Monaco. Both avoid
    // the plain textarea. TiptapBody may normalize trailing whitespace, so trim.
    await win.locator('[data-testid="doc-tab-readme.md"]').click({ force: true })
    await win.waitForTimeout(300)
    const readmeBuf = await storeBufferText(win, PATHS.readme)
    expect(readmeBuf?.trim()).toBe(readmeContent.trim())
    await expect(win.locator('[data-testid="doc-textarea"]')).not.toBeVisible()

    await win.locator('[data-testid="doc-tab-settings.json"]').click({ force: true })
    await win.waitForTimeout(300)
    const settingsBuf = await storeBufferText(win, PATHS.settings)
    expect(settingsBuf).toBe(settingsContent)
    await expect(win.locator('[data-testid="doc-textarea"]')).not.toBeVisible()

    // notes.txt is unknown extension — uses plain textarea.
    await win.locator('[data-testid="doc-tab-notes.txt"]').click({ force: true })
    await expect(win.locator('[data-testid="doc-textarea"]')).toHaveValue(notesContent, { timeout: 3_000 })
  } finally {
    await app.close()
  }
})

test('edit one tab, switch away, switch back — edit is preserved', async () => {
  const { app, win } = await launchApp()
  try {
    await navigateToTab(win, 'doc-editor')
    await win.waitForTimeout(300)

    await openDocViaEval(win, PATHS.readme)
    await openDocViaEval(win, PATHS.settings)

    // readme.md is Monaco — edit via store.
    await win.locator('[data-testid="doc-tab-readme.md"]').click({ force: true })
    await win.waitForTimeout(300)
    await storeEdit(win, PATHS.readme, '## EDITED CONTENT')

    // Switch to settings tab.
    await win.locator('[data-testid="doc-tab-settings.json"]').click({ force: true })
    await win.waitForTimeout(200)
    const settingsBuf = await storeBufferText(win, PATHS.settings)
    expect(settingsBuf).not.toBe('## EDITED CONTENT')

    // Switch back to readme — edit must be preserved in store.
    await win.locator('[data-testid="doc-tab-readme.md"]').click({ force: true })
    await win.waitForTimeout(200)
    const readmeBuf = await storeBufferText(win, PATHS.readme)
    expect(readmeBuf).toBe('## EDITED CONTENT')
  } finally {
    await app.close()
  }
})

test('save clears the dirty indicator', async () => {
  const { app, win } = await launchApp()
  try {
    await navigateToTab(win, 'doc-editor')
    await win.waitForTimeout(300)

    await openDocViaEval(win, PATHS.readme)

    // readme.md is Monaco — edit via store to make dirty.
    await storeEdit(win, PATHS.readme, 'dirty edit for save test')

    // Dirty dot should be visible.
    await expect(win.locator('[data-testid="doc-tab-dirty"]').first()).toBeVisible({ timeout: 3_000 })

    // Click Save.
    await win.locator('[data-testid="doc-save-btn"]').click({ force: true })

    // Dirty dot must disappear.
    await expect(win.locator('[data-testid="doc-tab-dirty"]')).toHaveCount(0, { timeout: 5_000 })
  } finally {
    await app.close()
  }
})

test('reload restores previously open docs', async () => {
  const { app, win } = await launchApp()
  try {
    await navigateToTab(win, 'doc-editor')
    await win.waitForTimeout(300)

    await openDocViaEval(win, PATHS.readme)
    await openDocViaEval(win, PATHS.settings)
    await openDocViaEval(win, PATHS.notes)

    // Wait for the 500ms persistence debounce + margin.
    await win.waitForTimeout(800)

    // Reload the renderer.
    await win.reload({ timeout: 15_000 })
    await win.waitForSelector('text=Claude Session Manager', { timeout: 15_000 })
    await win.waitForTimeout(300)

    // Navigate to doc-editor to trigger hydration.
    await navigateToTab(win, 'doc-editor')

    // All three tabs should re-open (hydration is async — allow extra time).
    await expect(win.locator('[data-testid="doc-tab-strip"] > [data-testid^="doc-tab-"]:not([data-testid^="doc-tab-close-"])')).toHaveCount(3, { timeout: 10_000 })

    // The last-opened file (notes.txt, plain textarea) should be active.
    const textarea = win.locator('[data-testid="doc-textarea"]')
    const notesContent = await fs.readFile(PATHS.notes, 'utf8')
    await expect(textarea).toHaveValue(notesContent, { timeout: 5_000 })
  } finally {
    await app.close()
  }
})
