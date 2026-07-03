/**
 * Memory Clusters smoke — the Clusters view of the Memory tab's Workspace
 * scope. Only exercises the cache-only mount path (memory:aggregate with
 * refresh:false); never triggers `claude -p` (that's gated behind an
 * explicit Aggregate click, which this test does not perform).
 */
import { test, expect } from '@playwright/test'
import { launchApp, navigateToTab } from './_helpers/launchApp'

test('Memory tab Clusters view renders cache-only state + Aggregate button', async () => {
  const { app, win, errors } = await launchApp()
  try {
    await navigateToTab(win, 'memory')

    // Workspace scope is the default; switch to the Clusters sub-view.
    const clustersTab = win.getByRole('button', { name: 'Clusters', exact: true })
    await clustersTab.waitFor({ state: 'visible', timeout: 5_000 })
    await clustersTab.click()

    // Cache-only load resolves quickly; either the empty state or cached
    // cluster cards render — either way an Aggregate/Refresh button is present.
    const actionButton = win.getByRole('button', { name: /^(Aggregate|Refresh|Aggregating…)$/ })
    await actionButton.waitFor({ state: 'visible', timeout: 5_000 })

    await win.waitForTimeout(500)

    const real = errors.filter((e) => !/Autofill\.enable|Autofill\.setAddresses/.test(e))
    expect(real, `errors during Memory Clusters mount: ${real.join(' | ')}`).toEqual([])
  } finally {
    await app.close()
  }
})
