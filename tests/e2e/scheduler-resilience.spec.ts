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
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
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

test('meter_rate_limited billing responses do not pause the queue', async () => {
  const app = await electron.launch({
    args: [path.join(ROOT, 'src', 'main', 'index.cjs')],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      SM_E2E: '1',
      // Simulate sustained meter rate-limiting from the billing API.
      SM_MOCK_BILLING_KIND: 'meter_rate_limited',
    },
  })

  const win = await app.firstWindow()
  await win.waitForSelector('text=Claude Session Manager', { timeout: 15000 })
  // Give the scheduler time to boot and run its first poll (which will get meter_rate_limited).
  await win.waitForTimeout(5000)

  // Navigate to the Scheduler panel.
  const schedulerNav = win.locator('button', { hasText: /scheduler/i }).first()
  if (await schedulerNav.count() > 0) {
    await schedulerNav.click()
    await win.waitForTimeout(500)
  }

  // Click "Fire next batch now" to bypass the billing gate.
  const fireBtn = win.locator('button', { hasText: /fire next batch now/i })
  if (await fireBtn.count() > 0 && !(await fireBtn.isDisabled())) {
    await fireBtn.click()
    await win.waitForTimeout(3000)
  }

  // Primary assertion: queue must NOT be in paused:network state.
  const queueState = readQueueState()
  expect(queueState?.paused?.reason).not.toBe('network')

  await app.close()
})

test('"Fire next batch now" button is visible in SchedulePanel', async () => {
  const app = await electron.launch({
    args: [path.join(ROOT, 'src', 'main', 'index.cjs')],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      SM_E2E: '1',
      SM_MOCK_BILLING_KIND: 'meter_rate_limited',
    },
  })

  const win = await app.firstWindow()
  await win.waitForSelector('text=Claude Session Manager', { timeout: 15000 })
  await win.waitForTimeout(2000)

  // The "Fire next batch now" button should exist somewhere in the page.
  const fireBtn = win.locator('button', { hasText: /fire next batch now/i })
  await expect(fireBtn.first()).toBeVisible({ timeout: 10000 })

  await app.close()
})
