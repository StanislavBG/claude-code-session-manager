/**
 * Scheduler resilience e2e test.
 *
 * Verifies that a sustained `meter_rate_limited` response from fetchUsage does NOT
 * put the queue into `paused: {reason: "network"}`. With SM_MOCK_BILLING_KIND set,
 * usage.cjs returns meter_rate_limited on every poll, and the scheduler should
 * fire pending jobs on heuristic (cachedUtilization=0) rather than pausing.
 *
 * Prerequisites: the `claude` CLI must be on PATH for jobs to complete successfully.
 * If claude is unavailable, jobs will fail but the queue should still not enter
 * the network-pause state (which is the primary assertion of this test).
 */
import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { launchApp, navigateToTab } from './_helpers/launchApp'

const PRDS_DIR = path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans', 'prds')
const QUEUE_JSON = path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans', 'queue.json')

const TEST_SLUGS = [
  'e2e-test-resilience-a',
  'e2e-test-resilience-b',
  'e2e-test-resilience-c',
]

const MINIMAL_PRD_BODY = (slug: string) => `---
title: E2E resilience test job ${slug}
cwd: /tmp
estimateMinutes: 1
---

Print a single line and exit.

# Acceptance criteria
- [ ] Script exits 0.

# Implementation notes
\`\`\`bash
echo "e2e-test-ok-${slug}"
\`\`\`
`

function writeMockPrds() {
  fs.mkdirSync(PRDS_DIR, { recursive: true })
  for (const slug of TEST_SLUGS) {
    fs.writeFileSync(path.join(PRDS_DIR, `${slug}.md`), MINIMAL_PRD_BODY(slug))
  }
}

function cleanupMockPrds() {
  for (const slug of TEST_SLUGS) {
    try { fs.unlinkSync(path.join(PRDS_DIR, `${slug}.md`)) } catch { /* */ }
  }
}

function readQueueState(): { paused?: { reason: string } | null; jobs?: { slug: string; status: string }[] } | null {
  try { return JSON.parse(fs.readFileSync(QUEUE_JSON, 'utf8')) }
  catch { return null }
}

test.beforeEach(() => {
  writeMockPrds()
})

test.afterEach(() => {
  cleanupMockPrds()
})

/**
 * The Scheduler section in LeftNav is collapsed-by-default whenever the
 * snapshot reports no pending/running/paused work. `defaultCollapsed` is
 * read once at mount, before the snapshot poller hydrates — so even when
 * PRDs exist on disk, the section starts collapsed and the SchedulePanel
 * (which hosts "Fire next batch now") isn't in the DOM. Force it open via
 * the localStorage key the section persists to, then reload so the
 * useState initializer reads it.
 */
// Scheduler is now a top-level nav tab (was a collapsible left-nav section).
// Navigate to it via the command palette and land on the Queue subview, which
// hosts SchedulePanel and its "Fire next batch now" control. The subview is
// persisted in localStorage and other scheduler specs leave it on 'prds', so
// force 'queue' BEFORE navigating — the Scheduler reads it in a mount-time
// useState initializer.
async function expandSchedulerSection(win: import('@playwright/test').Page) {
  await win.waitForSelector('[data-testid="tour-tabbar"]', { timeout: 15_000 })
  await win.evaluate(() => localStorage.setItem('sm.schedulerTab.subView', 'queue'))
  await navigateToTab(win, 'scheduler')
  // Belt-and-suspenders: if the tab was already mounted, click the Queue subtab.
  const queueTab = win.locator('button', { hasText: /^queue$/i }).first()
  if (await queueTab.count() > 0) await queueTab.click().catch(() => { /* already active */ })
}

test('meter_rate_limited billing responses do not pause the queue', async () => {
  const { app, win } = await launchApp()
  await expandSchedulerSection(win)
  // Give the scheduler time to boot and run its first poll (which will get meter_rate_limited).
  await win.waitForTimeout(5000)

  // Click "Fire next batch now" to bypass the billing gate.
  const fireBtn = win.locator('button', { hasText: /fire next batch now/i }).first()
  if (await fireBtn.count() > 0 && !(await fireBtn.isDisabled())) {
    await fireBtn.click({ force: true })
    await win.waitForTimeout(3000)
  }

  // Primary assertion: queue must NOT be in paused:network state.
  const queueState = readQueueState()
  expect(queueState?.paused?.reason).not.toBe('network')

  await app.close()
})

test('"Fire next batch now" button is visible in SchedulePanel', async () => {
  const { app, win } = await launchApp()
  await expandSchedulerSection(win)
  await win.waitForTimeout(2000)

  // The "Fire next batch now" button should exist somewhere in the page.
  const fireBtn = win.locator('button', { hasText: /fire next batch now/i })
  await expect(fireBtn.first()).toBeVisible({ timeout: 10000 })

  await app.close()
})
