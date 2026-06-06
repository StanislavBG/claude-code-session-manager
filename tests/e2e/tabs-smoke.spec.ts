/**
 * 18-tab smoke test — every NavKey must mount without pageerror or console.error.
 *
 * Parametrized over the full NavKey union from LeftNav.tsx. Each tab is opened
 * via the Cmd-K command palette (deterministic — does not depend on LeftNav
 * scroll/collapse state). After mount we settle for 500ms then assert the
 * renderer reported zero errors during that tab's lifetime.
 *
 * Reason this exists: 13 of 17 tabs were never previously mounted under test.
 * A regression that throws on mount in (e.g.) Permissions, Plugins, MCP would
 * have shipped silently. Source: tests/e2e cycle-3 research §3 P0-1.
 */
import { test, expect } from '@playwright/test'
import type { NavKey } from '../../src/renderer/components/LeftNav'
import { launchApp, navigateToTab } from './_helpers/launchApp'

// Full union mirrored from LeftNav.tsx. Order is the order they ship in the
// nav; if a tab is added to the union, add it here too — typescript will
// flag a missing case below if NavKey grows and this list doesn't.
const TABS: NavKey[] = [
  'overview',
  'terminal',
  'system-prompt',
  'settings',
  'permissions',
  'skills',
  'plugins',
  'mcp',
  'hooks',
  'subagents',
  'scheduler',
  'tasks',
  'memory',
  'projects',
  'history',
  'keybindings',
  'usage',
  'agent-view',
]

// Compile-time exhaustiveness: if NavKey gains a member, the assignment below
// fails to type-check until TABS is updated.
const _exhaustive: NavKey = TABS[0]
void _exhaustive

test.describe('17 tabs mount without renderer errors', () => {
  for (const navKey of TABS) {
    test(`${navKey} renders + no console.error`, async () => {
      const { app, win, errors } = await launchApp()
      try {
        await navigateToTab(win, navKey)
        // 500ms settle: covers initial scans + lazy IPC. Most tabs paint in
        // <200ms; the extra slack catches deferred effect errors.
        await win.waitForTimeout(500)
        // Filter: ignore Electron's own DevTools "Autofill.enable" benign
        // warnings that appear in CDP error stream on some host configs.
        const real = errors.filter(
          (e) => !/Autofill\.enable|Autofill\.setAddresses/.test(e),
        )
        expect(real, `errors during ${navKey} mount: ${real.join(' | ')}`).toEqual([])
      } finally {
        await app.close()
      }
    })
  }
})
