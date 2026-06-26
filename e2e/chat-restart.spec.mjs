// chat-restart.spec.mjs — "restart rehearsal" for the v0.34 terminal chat.
// Verifies that a normal boot lands on the dormant chat box, spawns ZERO claude
// processes until the user acts, and that Send wires through to a headless run.
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

async function launch() {
  const seedTab = {
    id: `restart-tab-${Date.now()}`,
    claudeSessionId: `restart-session-${Date.now()}`,
    cwd: ROOT,
    label: 'restart-rehearsal',
    presetId: 'pick-dangerous',
  }
  fs.mkdirSync(path.dirname(TABS_JSON), { recursive: true })
  fs.writeFileSync(TABS_JSON, JSON.stringify({ tabs: [seedTab], activeTabId: seedTab.id }))

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
  await win.waitForSelector('text=Claude Session Manager', { timeout: 20_000 })
  await win.waitForTimeout(2500)
  return { app, win, errors }
}

// SAFE, fast, claude-free: the core restart regression.
test('boot: dormant chat box renders + ZERO claude on boot', async () => {
  const { app, win, errors } = await launch()
  const mainPid = app.process().pid

  // 1) App booted, no fatal page errors.
  expect(errors, `page errors on boot: ${errors.join(' | ')}`).toEqual([])

  // 2) Dormant chat box renders (NOT a live xterm). The "Open raw session"
  //    button + the chat textarea are the TerminalChat signature.
  await expect(win.getByRole('button', { name: /Open raw session/i })).toBeVisible({ timeout: 15_000 })
  await expect(win.getByPlaceholder(/Type a command/i)).toBeVisible({ timeout: 5_000 })

  // 3) ZERO claude processes spawned by the app on boot (the core regression).
  const onBoot = claudeChildrenOf(mainPid)
  expect(onBoot, `expected 0 claude children on boot, found ${onBoot}`).toBe(0)

  // 4) Evidence: the visible chat-box text (reliable), plus a best-effort
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
  const { app, win } = await launch()
  const mainPid = app.process().pid
  const input = win.getByPlaceholder(/Type a command/i)
  await expect(input).toBeVisible({ timeout: 15_000 })

  await input.fill('print exactly: chat-restart-ok')
  await win.getByRole('button', { name: /^Send$/ }).click()
  await expect(win.getByText(/running…|queued ·/i)).toBeVisible({ timeout: 8_000 })

  let spawned = 0
  for (let i = 0; i < 20 && spawned === 0; i++) { spawned = claudeChildrenOf(mainPid); await win.waitForTimeout(500) }
  await win.screenshot({ path: path.join(ROOT, 'e2e', '_artifacts-chat-running.png') })
  expect(spawned, 'a claude child should spawn after Send').toBeGreaterThan(0)

  const cancelBtn = win.getByRole('button', { name: /^Cancel$/ })
  if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click()
  await app.close()
})
