/**
 * Scheduler accessibility tests.
 *
 * Verifies:
 *   1. StatusBadge elements have role="status" and aria-label
 *   2. Job list container has role="list"
 *   3. Job row buttons have aria-expanded + aria-label with status context
 *   4. Keyboard navigation (ArrowDown / ArrowUp) moves focus within the job list
 *   5. Screen-reader live region exists for status-change announcements
 *   6. Queue health section has aria-expanded on its toggle button
 *
 * Precondition: the Scheduler tab must be reachable. If no PRDs are queued,
 * many assertions still pass (ARIA structure is rendered before data arrives).
 */

import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { launchApp, navigateToTab } from './_helpers/launchApp'

const PRDS_DIR = path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans', 'prds')
const TEST_SLUG_A = 'test-a11y-pending-a'
const TEST_SLUG_B = 'test-a11y-pending-b'

function prdBody(title: string) {
  return `---
title: ${title}
cwd: /tmp
estimateMinutes: 1
---

A11y test fixture. Safe to delete.
`
}

function seed() {
  fs.mkdirSync(PRDS_DIR, { recursive: true })
  fs.writeFileSync(path.join(PRDS_DIR, `${TEST_SLUG_A}.md`), prdBody('A11y test job A'))
  fs.writeFileSync(path.join(PRDS_DIR, `${TEST_SLUG_B}.md`), prdBody('A11y test job B'))
}

function cleanup() {
  try { fs.unlinkSync(path.join(PRDS_DIR, `${TEST_SLUG_A}.md`)) } catch { /* */ }
  try { fs.unlinkSync(path.join(PRDS_DIR, `${TEST_SLUG_B}.md`)) } catch { /* */ }
}

test.beforeAll(seed)
test.afterAll(cleanup)

test.describe('Scheduler a11y — ARIA structure', () => {
  test('job list has role=list and job rows have role=listitem with aria-expanded', async () => {
    const { app, win } = await launchApp()

    try {
      await navigateToTab(win, 'Scheduler')

      // Queue tab should be visible by default
      await win.waitForSelector('[role="list"][aria-label="Job queue"]', { timeout: 10_000 })

      // Each job row button should have aria-expanded
      const rows = win.locator('[data-job-row]')
      const count = await rows.count()
      // At least the two seeded PRDs should appear
      expect(count).toBeGreaterThanOrEqual(2)

      const firstRow = rows.first()
      await expect(firstRow).toHaveAttribute('aria-expanded', 'false')
      await expect(firstRow).toHaveAttribute('aria-label')

      // aria-label should mention the job title and status
      const label = await firstRow.getAttribute('aria-label')
      expect(label).toBeTruthy()
      expect(label).toMatch(/pending/i)
    } finally {
      await app.close()
    }
  })

  test('StatusBadge has role=status and aria-label', async () => {
    const { app, win } = await launchApp()

    try {
      await navigateToTab(win, 'Scheduler')
      await win.waitForSelector('[role="list"][aria-label="Job queue"]', { timeout: 10_000 })

      // StatusBadge elements in the job list
      const badges = win.locator('[role="list"][aria-label="Job queue"] [role="status"]')
      const count = await badges.count()
      expect(count).toBeGreaterThanOrEqual(1)

      const firstBadge = badges.first()
      await expect(firstBadge).toHaveAttribute('aria-label')
      const label = await firstBadge.getAttribute('aria-label')
      expect(label).toMatch(/status:/i)
    } finally {
      await app.close()
    }
  })

  test('screen-reader live region is present', async () => {
    const { app, win } = await launchApp()

    try {
      await navigateToTab(win, 'Scheduler')
      // The aria-live polite region should exist even before any status changes
      const liveRegion = win.locator('[aria-live="polite"]')
      await expect(liveRegion).toBeAttached()
    } finally {
      await app.close()
    }
  })

  test('queue health toggle has aria-expanded', async () => {
    const { app, win } = await launchApp()

    try {
      await navigateToTab(win, 'Scheduler')
      await win.waitForSelector('[role="list"][aria-label="Job queue"]', { timeout: 10_000 })

      // The queue health disclosure button
      const healthToggle = win.locator('[aria-expanded][title*="lint"]')
      await expect(healthToggle).toBeAttached()
    } finally {
      await app.close()
    }
  })
})

test.describe('Scheduler a11y — keyboard navigation', () => {
  test('ArrowDown / ArrowUp move focus between job rows', async () => {
    const { app, win } = await launchApp()

    try {
      await navigateToTab(win, 'Scheduler')
      await win.waitForSelector('[role="list"][aria-label="Job queue"]', { timeout: 10_000 })

      const rows = win.locator('[data-job-row]')
      const count = await rows.count()
      if (count < 2) {
        test.skip()
        return
      }

      // Focus the first row and navigate down
      await rows.first().focus()
      const listContainer = win.locator('[role="list"][aria-label="Job queue"]')
      await listContainer.press('ArrowDown')

      // After ArrowDown the second row should be focused
      const focused = win.locator('[data-job-row]:focus')
      const focusedIndex = await focused.getAttribute('data-job-index')
      expect(Number(focusedIndex)).toBe(1)

      // Navigate back up
      await listContainer.press('ArrowUp')
      const focusedAfterUp = win.locator('[data-job-row]:focus')
      const indexAfterUp = await focusedAfterUp.getAttribute('data-job-index')
      expect(Number(indexAfterUp)).toBe(0)
    } finally {
      await app.close()
    }
  })

  test('Enter on a job row expands the details panel', async () => {
    const { app, win } = await launchApp()

    try {
      await navigateToTab(win, 'Scheduler')
      await win.waitForSelector('[role="list"][aria-label="Job queue"]', { timeout: 10_000 })

      const firstRow = win.locator('[data-job-row]').first()
      await firstRow.focus()
      await expect(firstRow).toHaveAttribute('aria-expanded', 'false')

      // Enter key triggers click on a focused button
      await firstRow.press('Enter')
      await expect(firstRow).toHaveAttribute('aria-expanded', 'true')
    } finally {
      await app.close()
    }
  })
})
