/**
 * Scheduler Archive destructive-op test.
 *
 * Verifies the full archive flow:
 *   1. Seed PRDS_DIR/test-archive-e2e.md with valid frontmatter.
 *   2. Launch app, navigate to Plans → prds.
 *   3. Select the seeded PRD via its checkbox, click Archive…, confirm.
 *   4. Assert: source file gone, present under prds-archived/<ts>/.
 *
 * Path containment is enforced by queueOps.cjs:252 — we only rely on the
 * UI flow, not on internals.
 *
 * Cleanup: removes any prds-archived/* directories we created. Never touches
 * pre-existing user PRDs (we use a unique e2e- slug).
 */
import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { launchApp, navigateToTab } from './_helpers/launchApp'

const ROOT_DIR = path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans')
const PRDS_DIR = path.join(ROOT_DIR, 'prds')
const ARCHIVE_DIR = path.join(ROOT_DIR, 'prds-archived')

const TEST_SLUG = 'test-archive-e2e'
const TEST_PRD_PATH = path.join(PRDS_DIR, `${TEST_SLUG}.md`)

const PRD_BODY = `---
title: E2E archive test
cwd: /tmp
estimateMinutes: 1
---

E2E test fixture. Safe to delete.
`

function seedPrd() {
  fs.mkdirSync(PRDS_DIR, { recursive: true })
  fs.writeFileSync(TEST_PRD_PATH, PRD_BODY)
}

function cleanup() {
  try { fs.unlinkSync(TEST_PRD_PATH) } catch { /* may already be archived */ }
  // Remove any archive directory that contains our test slug.
  try {
    const dirs = fs.readdirSync(ARCHIVE_DIR)
    for (const d of dirs) {
      const archivedFile = path.join(ARCHIVE_DIR, d, `${TEST_SLUG}.md`)
      if (fs.existsSync(archivedFile)) {
        fs.rmSync(path.join(ARCHIVE_DIR, d), { recursive: true, force: true })
      }
    }
  } catch { /* */ }
}

test.beforeEach(() => {
  cleanup()
  seedPrd()
})

test.afterEach(() => {
  cleanup()
})

test('Archive moves PRD from prds/ to prds-archived/<ts>/', async () => {
  const { app, win } = await launchApp({
    env: { SM_MOCK_BILLING_KIND: 'ok' },
  })
  try {
    // Force the prds subview BEFORE navigating: the Scheduler reads
    // 'sm.schedulerTab.subView' in a mount-time useState initializer, so setting
    // it after navigateToTab (when the tab is already mounted on 'queue') is too
    // late and leaves SchedulePanel showing instead of SchedulerPrdsView — the
    // seeded slug then never renders. Force-click the PRDs subtab as a backup
    // (the poller's LeftNav-badge churn defeats normal click stability).
    await win.evaluate(() => localStorage.setItem('sm.schedulerTab.subView', 'prds'))
    await navigateToTab(win, 'scheduler')
    const prdsTab = win.locator('button', { hasText: /^prds$/i }).first()
    if (await prdsTab.count() > 0) {
      await prdsTab.click({ force: true }).catch(() => { /* may already be active */ })
    }

    // Wait for the seeded slug to appear in the sidebar list.
    const slugRow = win.locator(`text=${TEST_SLUG}`).first()
    await expect(slugRow).toBeVisible({ timeout: 10_000 })

    // Click the checkbox in the same row as the slug.
    // SchedulerPrdsView.tsx:382 — each row is a flex container with a
    // checkbox label and a slug button. Match the row by its own class so
    // we don't accidentally pick the whole sidebar (which would yield the
    // wrong PRD's checkbox when other PRDs exist in the user's prds/).
    // Force the click — the snapshot poller re-renders rows every 2s,
    // defeating Playwright's stability check even though the checkbox
    // itself is functionally hittable.
    const row = win.locator('div.flex.items-stretch', {
      has: win.locator(`text=${TEST_SLUG}`),
    }).first()
    await row.locator('input[type="checkbox"]').first().check({ force: true })

    // Click the bulk-bar Archive button.
    const archiveBtn = win.locator('button', { hasText: /^archive…$/i }).first()
    await archiveBtn.click({ force: true })

    // Modal confirm — button text is "Archive 1".
    const confirmBtn = win.locator('button', { hasText: /^archive 1$/i }).first()
    await confirmBtn.click({ force: true })

    // Modal closes + list refreshes; the slug should disappear from sidebar.
    await expect(win.locator(`text=${TEST_SLUG}`)).toHaveCount(0, { timeout: 10_000 })

    // Filesystem assertions.
    expect(fs.existsSync(TEST_PRD_PATH)).toBe(false)

    // Find the new archive directory that contains our slug.
    const archives = fs.existsSync(ARCHIVE_DIR) ? fs.readdirSync(ARCHIVE_DIR) : []
    const archivedHere = archives.find((d) =>
      fs.existsSync(path.join(ARCHIVE_DIR, d, `${TEST_SLUG}.md`)),
    )
    expect(archivedHere, 'no archive dir contains the test slug').toBeTruthy()
    expect(archivedHere).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  } finally {
    await app.close()
  }
})
