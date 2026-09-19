import { test, expect } from '@playwright/test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'

// bilko-host publish gate: smoke-checks the static bundle staged for
// /projects/session-manager/ before it's copied into the host repo.
// Root page must be untouched by the dashboard sub-path addition;
// the dashboard doc must load cleanly with its own distinct title.
const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST = join(__dirname, '..', 'session-manager-operations', 'bilko-host', 'dist')

// dist/ is gitignored build output — a fresh checkout has none.
test.skip(!existsSync(join(DIST, 'index.html')), 'session-manager-operations/bilko-host/dist/index.html is absent (gitignored build output)')

test('root marketing page still serves', async ({ page }) => {
  await page.goto(pathToFileURL(join(DIST, 'index.html')).href)
  await expect(page).toHaveTitle('Session Manager')
})

test('dashboard sub-path document loads with its own title', async ({ page }) => {
  await page.goto(pathToFileURL(join(DIST, 'dashboard', 'index.html')).href)
  await expect(page).toHaveTitle('Session Manager — Usage Dashboard')
})
