/**
 * Shared tabs.json backup/restore for the legacy e2e specs.
 *
 * Seven specs in /e2e/*.mjs (new-session, broadcast, mic, watchers,
 * history-dashboard, live-transcript, overview-billing) all had identical
 * beforeEach/afterEach blocks that:
 *   1. backed tabs.json to .bak,
 *   2. removed the live file,
 *   3. on teardown restored the .bak and removed it.
 *
 * Centralizing here so specs read: `installTabsJsonBackup()` at top.
 *
 * Usage:
 *   import { test } from '@playwright/test'
 *   import { installTabsJsonBackup, TABS_JSON } from './_helpers/tabsJsonBackup.mjs'
 *   installTabsJsonBackup(test)
 */
import fs from 'node:fs'
import path from 'node:path'

export const TABS_JSON = path.join(process.env.HOME, '.config', 'session-manager', 'tabs.json')

export function installTabsJsonBackup(test) {
  test.beforeEach(() => {
    if (fs.existsSync(TABS_JSON)) {
      fs.copyFileSync(TABS_JSON, TABS_JSON + '.bak')
      fs.unlinkSync(TABS_JSON)
    }
  })
  test.afterEach(() => {
    if (fs.existsSync(TABS_JSON + '.bak')) {
      fs.copyFileSync(TABS_JSON + '.bak', TABS_JSON)
      fs.unlinkSync(TABS_JSON + '.bak')
    }
  })
}
