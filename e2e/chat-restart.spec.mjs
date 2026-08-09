// chat-restart.spec.mjs — "restart rehearsal", updated for the retirement of
// the legacy TerminalChat surface: a dormant tab now renders the Epics
// workspace, not a per-tab "Open raw session"/chat textarea. Verifies that a
// normal boot lands there and spawns ZERO claude processes until the user acts.
//
// Run: xvfb-run -a npx playwright test e2e/chat-restart.spec.mjs

import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { installTabsJsonBackup, TABS_JSON } from './_helpers/tabsJsonBackup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// Navigate via the Cmd-K palette with keyboard Enter, mirroring
// tests/e2e/_helpers/launchApp.ts#navigateToTab: the app's pollers re-render
// constantly, so sidebar buttons are never "stable" enough for Playwright's
// click actionability checks — a raw .click() on the nav hangs until timeout.
async function gotoTerminal(win) {
  await win.keyboard.press('Control+K')
  const palette = win.locator('[data-testid="command-palette"]')
  await palette.waitFor({ state: 'visible', timeout: 5_000 })
  await win.locator('[data-testid="command-palette"] input[role="combobox"]').fill('go to terminal')
  await win.locator('button[data-cmd-id="nav:terminal"]').first().waitFor({ state: 'visible', timeout: 3_000 })
  await win.keyboard.press('Enter')
  await palette.waitFor({ state: 'hidden', timeout: 3_000 })
}

installTabsJsonBackup(test)

// Count claude processes that are descendants of the given pid (the Electron
// main process). Excludes unrelated claude sessions on the machine.
function claudeChildrenOf(pid) {
  let out = ''
  try { out = execSync(`pstree -p ${pid} 2>/dev/null || ps --ppid ${pid} -o pid=,comm= 2>/dev/null`, { encoding: 'utf8' }) } catch { /* none */ }
  // Broader sweep: any claude proc whose parent chain includes pid.
  let all = ''
  try { all = execSync('ps -eo pid=,ppid=,comm=,args=', { encoding: 'utf8' }) } catch { /* */ }
  const byPid = new Map()
  for (const line of all.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (m) byPid.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3], args: m[4] })
  }
  const isDescendant = (p) => {
    let cur = byPid.get(p)
    let hops = 0
    while (cur && hops++ < 40) {
      if (cur.ppid === pid) return true
      cur = byPid.get(cur.ppid)
    }
    return false
  }
  const matches = []
  for (const [p, info] of byPid) {
    // Key on the EXECUTABLE (argv0 basename === 'claude'), not arbitrary arg
    // text — otherwise the systemd-inhibit power-blocker (whose --why mentions
    // "claude -p jobs") false-positives.
    const argv0 = info.args.split(/\s+/)[0] || ''
    const isClaudeExe = /(^|\/)claude$/.test(argv0)
    if (isClaudeExe && isDescendant(p)) {
      matches.push(`pid=${p} ppid=${info.ppid} :: ${info.args.slice(0, 120)}`)
    }
  }
  if (matches.length) console.log(`[claude-descendants of ${pid}]\n  ${matches.join('\n  ')}`)
  return matches.length
}

// Active-index path mirrors promptSessionActiveIndexPath (promptSessions.ts)
// — kept as a literal here since e2e specs don't import renderer modules.
function epicActiveIndexPath(cwd) {
  return path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json')
}

async function launch({ withEpic = false } = {}) {
  // Tab id / claudeSessionId MUST be a real UUID — the chat engine passes it
  // to `claude -p --session-id`, which rejects non-UUIDs with exit code 1
  // ("Invalid session ID. Must be a valid UUID").
  const sessionId = crypto.randomUUID()
  const seedTab = {
    id: sessionId,
    claudeSessionId: sessionId,
    cwd: ROOT,
    label: 'restart-rehearsal',
    presetId: 'pick-dangerous',
  }
  fs.mkdirSync(path.dirname(TABS_JSON), { recursive: true })
  fs.writeFileSync(TABS_JSON, JSON.stringify({ tabs: [seedTab], activeTabId: seedTab.id }))

  let epic = null
  if (withEpic) {
    // Since the dormant tab now lands on the Epics workspace (not a per-tab
    // chat box), sending a prompt goes through the Epic composer — seed one
    // active Epic for this tab's cwd so it's preselected on mount.
    const now = new Date().toISOString()
    epic = {
      id: `psess-${crypto.randomUUID()}`,
      cwd: ROOT,
      goalText: 'restart-rehearsal epic',
      claudeSessionId: crypto.randomUUID(),
      status: 'active',
      createdAt: now,
      completedAt: null,
      tag: 'feature',
    }
    const indexPath = epicActiveIndexPath(ROOT)
    fs.mkdirSync(path.dirname(indexPath), { recursive: true })
    fs.writeFileSync(indexPath, JSON.stringify({
      sessions: { [epic.id]: epic },
      events: {
        [epic.id]: [{
          id: `pevt-${crypto.randomUUID()}`,
          promptSessionId: epic.id,
          kind: 'prompt',
          causedByEventId: null,
          at: now,
          text: epic.goalText,
        }],
      },
    }))
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-restart-'))
  // Electron flags (--user-data-dir, --no-sandbox) MUST precede the app path.
  const app = await electron.launch({
    args: [`--user-data-dir=${userDataDir}`, '--no-sandbox', path.join(ROOT, 'src', 'main', 'index.cjs')],
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'development', SM_E2E: '1' },
  })
  app.process().stderr?.on('data', (d) => process.stdout.write(`[main:stderr] ${d}`))
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await win.waitForSelector('[data-testid="tour-tabbar"]', { timeout: 20_000 })
  await win.waitForTimeout(2500)
  return { app, win, errors, epic }
}

// SAFE, fast, claude-free: the core restart regression.
test('boot: dormant chat box renders + ZERO claude on boot', async () => {
  const { app, win, errors } = await launch()
  const mainPid = app.process().pid

  // 1) App booted, no fatal page errors.
  expect(errors, `page errors on boot: ${errors.join(' | ')}`).toEqual([])

  // NOTE on locators: if the user's real Session Manager is open it rewrites
  // ~/.claude/session-manager/tabs.json between our seed-write and app boot,
  // so the test instance can hydrate MANY dormant tabs — every one mounts the
  // Epics workspace. Filter to the visible one instead of assuming a single tab.
  const workspaces = win.locator('[data-testid="epics-workspace"]')
  const visibleWorkspace = workspaces.locator('visible=true')

  // 2) The app boots on the Overview screen — the dormant tab's Epics
  //    workspace must NOT leak through it. (Regression: the per-tab layer
  //    once forced `visibility: visible`, overriding the hidden terminal
  //    layer, so this assertion passed without anything actually hidden.)
  await expect(visibleWorkspace).toHaveCount(0, { timeout: 15_000 })

  // 3) Navigate to Terminal: the dormant tab's Epics workspace renders (NOT a
  //    live xterm) — the workspace root is the dormant-tab signature now.
  await gotoTerminal(win)
  await expect(visibleWorkspace).toHaveCount(1, { timeout: 15_000 })

  // 4) ZERO claude processes spawned by the app on boot (the core regression) —
  //    even after landing on the terminal, the dormant tab must not spawn.
  const onBoot = claudeChildrenOf(mainPid)
  expect(onBoot, `expected 0 claude children on boot, found ${onBoot}`).toBe(0)

  // 5) Evidence: the visible chat-box text (reliable), plus a best-effort
  //    screenshot (page.screenshot can hang on web-font loading under xvfb).
  const visibleText = (await win.locator('body').innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[chat-box visible text] ${visibleText.slice(0, 300)}`)
  try {
    await win.screenshot({ path: path.join(ROOT, 'e2e', '_artifacts-chat-boot.png'), animations: 'disabled', caret: 'hide', timeout: 8000 })
    console.log('[screenshot] captured e2e/_artifacts-chat-boot.png')
  } catch (e) {
    console.log(`[screenshot] skipped (non-fatal): ${e.message.split('\n')[0]}`)
  }

  await app.close()
})

// Spawns a real claude child + needs auth — skipped in CI/automated runs to
// respect the ≤3 concurrent claude-p OOM ceiling. Run manually when the machine
// is quiet:  xvfb-run -a npx playwright test e2e/chat-restart.spec.mjs -g "send:"
test.skip('send: Enter wires a headless run (claude child spawns)', async () => {
  // The dormant tab's chat entry point is now the Epic composer (the legacy
  // TerminalChat "Open raw session" chat box was retired) — seed one active
  // Epic for this tab's cwd so EpicsWorkspace preselects it and shows the
  // composer immediately on navigating to Terminal.
  const { app, win } = await launch({ withEpic: true })
  const mainPid = app.process().pid
  // Boot lands on Overview — route to the terminal before interacting.
  await gotoTerminal(win)
  const input = win.locator('[data-testid="epic-composer-textarea"]').locator('visible=true')
  await expect(input).toHaveCount(1, { timeout: 15_000 })

  await input.fill('print exactly: chat-restart-ok')
  // Enter submits (see EpicComposer's onKeyDown); the Send button is skipped
  // for the same actionability reason as gotoTerminal.
  await input.press('Enter')
  await expect(win.getByText(/running…|queued ·/i).locator('visible=true').first()).toBeVisible({ timeout: 8_000 })

  let spawned = 0
  for (let i = 0; i < 20 && spawned === 0; i++) { spawned = claudeChildrenOf(mainPid); await win.waitForTimeout(500) }
  expect(spawned, 'a claude child should spawn after Send').toBeGreaterThan(0)

  // Full round-trip: the run's own final message renders verbatim in the chat.
  await expect(win.getByText('chat-restart-ok', { exact: true }).locator('visible=true').first())
    .toBeVisible({ timeout: 90_000 })
  // Best-effort evidence — page.screenshot can hang on font loading under xvfb.
  try {
    await win.screenshot({ path: path.join(ROOT, 'e2e', '_artifacts-chat-running.png'), timeout: 8000 })
  } catch { /* non-fatal */ }

  const cancelBtn = win.getByRole('button', { name: /^Cancel$/ }).locator('visible=true').first()
  if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click()
  await app.close()
})
