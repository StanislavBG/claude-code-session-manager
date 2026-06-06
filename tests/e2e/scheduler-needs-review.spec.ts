/**
 * Scheduler needs_review chip e2e test.
 *
 * Verifies the 'needs_review' UI surface added by the post-run verifier:
 *   1. Seed a PRD file + inject a queue.json entry with status 'needs_review'.
 *   2. Launch app, navigate to Plans → prds.
 *   3. Assert the 'needs_review' chip is visible in the sidebar.
 *   4. Assert the detail panel shows the verifier verdict row.
 *   5. Assert the 'Re-fire' button is present.
 *
 * The test directly seeds queue.json (merged, not replaced) so the renderer
 * sees the needs_review status without running an actual agent job. Cleanup
 * restores queue.json to its pre-test state.
 */
import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { launchApp, navigateToTab } from './_helpers/launchApp'

const ROOT_DIR = path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans')
const PRDS_DIR = path.join(ROOT_DIR, 'prds')
const QUEUE_PATH = path.join(ROOT_DIR, 'queue.json')

const TEST_SLUG = 'e2e-needs-review-test'
const TEST_PRD_PATH = path.join(PRDS_DIR, `${TEST_SLUG}.md`)

const PRD_BODY = `---
title: E2E needs-review test
cwd: /tmp
estimateMinutes: 1
---

E2E test fixture for the post-run verifier. Safe to delete.
`

// ─── queue.json helpers ───────────────────────────────────────────────────────

interface QueueJob {
  slug: string
  status: string
  title?: string
  cwd?: string
  parallelGroup?: number
  estimateMinutes?: number | null
  bodyPreview?: string
  runId?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  exitCode?: number | null
  error?: string | null
  verifierVerdict?: string
}

interface QueueState {
  config?: Record<string, unknown>
  jobs: QueueJob[]
  scheduledFor?: string | null
  lastRunAt?: string | null
  paused?: unknown
}

function readQueue(): QueueState {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8')) as QueueState
  } catch {
    return { jobs: [] }
  }
}

function writeQueue(state: QueueState) {
  fs.mkdirSync(ROOT_DIR, { recursive: true })
  const tmp = QUEUE_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, QUEUE_PATH)
}

function injectTestJob(state: QueueState): QueueState {
  const jobs = state.jobs.filter((j) => j.slug !== TEST_SLUG)
  jobs.push({
    slug: TEST_SLUG,
    title: 'E2E needs-review test',
    cwd: '/tmp',
    parallelGroup: 99,
    estimateMinutes: 1,
    bodyPreview: 'E2E test fixture for the post-run verifier.',
    status: 'needs_review',
    runId: '2026-05-24T00-00-00-000Z',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    error: 'Traceback + Error within 10 lines at event 2 (no self-recovery)',
    verifierVerdict: 'transcript_errors',
  })
  return { ...state, jobs }
}

function removeTestJob(state: QueueState): QueueState {
  return { ...state, jobs: state.jobs.filter((j) => j.slug !== TEST_SLUG) }
}

// ─── seed / cleanup ───────────────────────────────────────────────────────────

function seed() {
  fs.mkdirSync(PRDS_DIR, { recursive: true })
  fs.writeFileSync(TEST_PRD_PATH, PRD_BODY)
  const q = readQueue()
  writeQueue(injectTestJob(q))
}

function cleanup() {
  try { fs.unlinkSync(TEST_PRD_PATH) } catch { /* */ }
  try {
    const q = readQueue()
    writeQueue(removeTestJob(q))
  } catch { /* */ }
}

test.beforeEach(() => {
  cleanup()
  seed()
})

test.afterEach(() => {
  cleanup()
})

// ─── test: chip is visible ────────────────────────────────────────────────────

test('needs_review chip visible in prds sidebar after seeding downgraded entry', async () => {
  const { app, win } = await launchApp({
    env: { SM_MOCK_BILLING_KIND: 'ok' },
  })
  try {
    // Set the prds subview BEFORE navigating so the Scheduler mounts on it
    // (the subview is read in a mount-time useState initializer; setting it
    // after navigate leaves SchedulePanel showing and the seeded slug hidden).
    await win.evaluate(() => localStorage.setItem('sm.schedulerTab.subView', 'prds'))
    await navigateToTab(win, 'scheduler')
    const prdsTab = win.locator('button', { hasText: /^prds$/i }).first()
    if (await prdsTab.count() > 0) {
      await prdsTab.click({ force: true }).catch(() => { /* may already be active */ })
    }

    // Wait for the seeded slug to appear in the sidebar.
    const slugRow = win.locator(`text=${TEST_SLUG}`).first()
    await expect(slugRow).toBeVisible({ timeout: 10_000 })

    // The needs_review chip should be visible in the same sidebar row.
    const chip = win.locator('span', { hasText: 'needs_review' }).first()
    await expect(chip).toBeVisible({ timeout: 5_000 })
  } finally {
    await app.close()
  }
})

test('needs_review detail panel shows verifier verdict and Re-fire button', async () => {
  const { app, win } = await launchApp({
    env: { SM_MOCK_BILLING_KIND: 'ok' },
  })
  try {
    await win.evaluate(() => localStorage.setItem('sm.schedulerTab.subView', 'prds'))
    await navigateToTab(win, 'scheduler')
    const prdsTab = win.locator('button', { hasText: /^prds$/i }).first()
    if (await prdsTab.count() > 0) {
      await prdsTab.click({ force: true }).catch(() => { /* */ })
    }

    // Click the PRD in the sidebar to load the detail panel.
    const slugBtn = win.locator('button', { hasText: TEST_SLUG }).first()
    await expect(slugBtn).toBeVisible({ timeout: 10_000 })
    await slugBtn.click({ force: true })

    // Detail pane: verifier verdict row should show 'transcript_errors'.
    const verdictLabel = win.locator('span', { hasText: 'transcript_errors' }).first()
    await expect(verdictLabel).toBeVisible({ timeout: 5_000 })

    // Re-fire button should be visible (only for needs_review status).
    const refireBtn = win.locator('button', { hasText: /re-fire/i }).first()
    await expect(refireBtn).toBeVisible({ timeout: 5_000 })
  } finally {
    await app.close()
  }
})
