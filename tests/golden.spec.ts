import { test, expect } from '@playwright/test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'

// bilko-host publish gate: smoke-checks the static bundle staged for
// /projects/session-manager/ before it's copied into the host repo.
// Root page must be untouched by the dashboard sub-path addition;
// the dashboard doc must load cleanly with its own distinct title.
const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST = join(__dirname, '..', 'session-manager-operations', 'bilko-host', 'dist')

test('root marketing page still serves', async ({ page }) => {
  await page.goto(pathToFileURL(join(DIST, 'index.html')).href)
  await expect(page).toHaveTitle('Session Manager')
})

test('dashboard sub-path document loads with its own title', async ({ page }) => {
  await page.goto(pathToFileURL(join(DIST, 'dashboard', 'index.html')).href)
  await expect(page).toHaveTitle('Session Manager — Usage Dashboard')
})
