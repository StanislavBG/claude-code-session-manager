/**
 * Prompts library — e2e coverage for PRD 32.
 *
 * Five tests lock down the four behaviours that would silently regress:
 *   T1  Tab mounts without renderer errors
 *   T2  Seed prompts load — all 8 categories visible + ≥40 rows in sidebar
 *   T3  Selecting a prompt + "Use prompt" opens TweakModal with correct fields
 *   T4  Paste mode writes WITHOUT trailing \n; auto-fire appends \n
 *   T5  "Edit root template" persists the body across modal close-reopen
 *
 * Conventions (per project anti-flake rules):
 *   - No waitForTimeout > 1000ms (the 500ms settle in T1 is the one exception,
 *     mirroring tabs-smoke.spec.ts for renderer settle — not for app state).
 *   - State waits use waitForFunction or web-first expect().toBeVisible() etc.
 *   - Each test closes its own app in a finally block.
 *   - T5 file-system override is cleaned up in afterEach.
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchApp, navigateToTab } from './_helpers/launchApp'

// Override file written by T5 — cleaned in afterEach.
const OVERRIDE_PATH = path.join(
  os.homedir(),
  '.claude/session-manager/prompts/security/owasp-top-10-staged-diff.md',
)

const CATEGORIES = [
  'Security',
  'QA',
  'Performance',
  'Code Review',
  'Debugging',
  'Refactoring',
  'Documentation',
  'Git / PR',
] as const

test.afterEach(() => {
  // T5 teardown: delete the user-override file if it was written during the test.
  try {
    fs.unlinkSync(OVERRIDE_PATH)
  } catch {
    // File may not exist if T5 never ran or save failed — that's fine.
  }
})

// ─── T1 ──────────────────────────────────────────────────────────────────────

test('prompts tab mounts without renderer errors', async () => {
  const { app, win, errors } = await launchApp()
  try {
    await navigateToTab(win, 'prompts')
    // 500ms settle — matches tabs-smoke.spec.ts; covers deferred-effect errors.
    await win.waitForTimeout(500)
    const autofillRe = /Autofill\.enable|Autofill\.setAddresses/
    const real = errors.filter((e) => !autofillRe.exec(e))
    expect(real, `errors: ${real.join(' | ')}`).toEqual([])
  } finally {
    await app.close()
  }
})

// ─── T2 ──────────────────────────────────────────────────────────────────────

test('all 8 categories visible and ≥40 prompt rows rendered', async () => {
  const { app, win } = await launchApp()
  try {
    await navigateToTab(win, 'prompts')

    // Each category group header should be visible in the sidebar.
    for (const cat of CATEGORIES) {
      await expect(win.locator(`text=${cat}`).first()).toBeVisible({ timeout: 10_000 })
    }

    // Prompt buttons in the sidebar have title={p.description}. The ListDetail
    // sidebar div uses the distinctive class combo: shrink-0 border-r border-line
    // overflow-y-auto. AlmanacSidebar uses border-r but NOT overflow-y-auto, so
    // this selector is unique to the Prompts list panel.
    const promptSidebar = win.locator('.shrink-0.border-r.border-line.overflow-y-auto')
    const promptRows = promptSidebar.locator('button[title]')
    await expect(promptRows.first()).toBeVisible({ timeout: 10_000 })
    const count = await promptRows.count()
    expect(count, `expected ≥40 prompt rows, got ${count}`).toBeGreaterThanOrEqual(40)
  } finally {
    await app.close()
  }
})

// ─── T3 ──────────────────────────────────────────────────────────────────────

test('Use prompt opens TweakModal with textarea, send button, and sendMode radios', async () => {
  const { app, win } = await launchApp()
  try {
    await navigateToTab(win, 'prompts')

    // Select the first Security prompt by its known title.
    const securityPrompt = win.locator(
      'button:has-text("Review staged diff for OWASP Top 10 issues")',
    )
    await expect(securityPrompt).toBeVisible({ timeout: 10_000 })
    // force: the 2s snapshot poller mutates LeftNav badges, shifting the main
    // pane and defeating Playwright's click-stability check (same workaround the
    // scheduler specs use). The button is functionally hittable.
    await securityPrompt.click({ force: true })

    // Wait for the detail panel to reflect the loaded prompt body.
    await expect(win.locator('pre').first()).toBeVisible({ timeout: 5_000 })

    // Click "Use prompt" — opens TweakModal regardless of activeTabId.
    await win.locator('button:has-text("Use prompt")').click({ force: true })

    // Modal should be visible.
    const modal = win.locator('[role="dialog"]')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // 1. Textarea pre-filled with non-empty body.
    const textarea = modal.locator('textarea[aria-label="Prompt body"]')
    await expect(textarea).toBeVisible()
    const bodyText = await textarea.inputValue()
    expect(bodyText.trim().length, 'prompt body should be non-empty').toBeGreaterThan(0)

    // 2. "Send to terminal" button exists (may be disabled without a session).
    await expect(modal.locator('button:has-text("Send to terminal")')).toBeVisible()

    // 3. sendMode radio group — both options present.
    await expect(modal.locator('input[type="radio"][value="paste"]')).toBeAttached()
    await expect(modal.locator('input[type="radio"][value="auto-fire"]')).toBeAttached()
  } finally {
    await app.close()
  }
})

// ─── T4 ──────────────────────────────────────────────────────────────────────

// QUARANTINED (headless limitation, not a product bug): this is the only spec
// that drives a LIVE interactive terminal — it clicks New Session, then asserts
// the PTY-backed `.xterm` becomes visible before spying on pty.write. MainPane
// gates the xterm with `visibility: hidden` until its tab is activeTabId, and
// under headless xvfb `createPickedSession()` never establishes a live session
// (no real `claude` binary / pty handshake), so the tab never activates and the
// xterm stays hidden. The paste-vs-auto-fire newline contract it covers is unit-
// testable separately; re-enable when the e2e env can spawn a real PTY session.
test.fixme('paste mode writes without trailing newline; auto-fire appends newline', async () => {
  const { app, win } = await launchApp()
  try {
    // Step 1 — mock window.api.app.pickDirectory so "New session" skips the
    // native OS dialog and immediately returns a valid directory.
    await win.evaluate(() => {
      ;(window as any).api.app.pickDirectory = async () => '/tmp'
    })

    // Step 2 — click New Session. handleNewSession calls setActiveNav('terminal')
    // then createPickedSession(), which calls our mock and adds a tab.
    await win.locator('[data-testid="tour-new-session"]').click({ force: true })

    // Step 3 — wait for the Terminal component to mount its xterm instance.
    // term.open(hostRef.current) adds the .xterm div; this is our proxy for
    // "activeTabId is set and the session is live enough for pty.write".
    await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 10_000 })

    // Step 4 — install pty.write spy BEFORE navigating to the prompts tab so
    // every subsequent write is captured.
    await win.evaluate(() => {
      ;(window as any).__ptyCalls = []
      const orig = (window as any).api.pty.write
      ;(window as any).api.pty.write = (payload: { tabId: string; data: string }) => {
        ;(window as any).__ptyCalls.push(payload)
        return orig?.(payload)
      }
    })

    // Step 5 — navigate to the Prompts tab.
    await navigateToTab(win, 'prompts')

    // Step 6 — select the Security prompt.
    const securityPrompt = win.locator(
      'button:has-text("Review staged diff for OWASP Top 10 issues")',
    )
    await expect(securityPrompt).toBeVisible({ timeout: 10_000 })
    await securityPrompt.click({ force: true })   // force: LeftNav badge poller shifts layout
    await expect(win.locator('pre').first()).toBeVisible({ timeout: 5_000 })

    // Step 7 — PASTE mode: open modal, switch to paste, click Send.
    await win.locator('button:has-text("Use prompt")').click({ force: true })
    const modal = win.locator('[role="dialog"]')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // Switch to paste mode (this prompt defaults to auto-fire).
    await modal.locator('input[type="radio"][value="paste"]').click({ force: true })
    await expect(modal.locator('input[type="radio"][value="paste"]')).toBeChecked()

    // Send button must be enabled (activeTabId is set).
    const sendBtn = modal.locator('button:has-text("Send to terminal")')
    await expect(sendBtn).toBeEnabled({ timeout: 3_000 })
    await sendBtn.click({ force: true })

    // Modal closes after send.
    await expect(modal).toHaveCount(0, { timeout: 3_000 })

    // Wait for the spy to record the write call.
    await win.waitForFunction(() => (window as any).__ptyCalls.length >= 1)

    const pasteCall = await win.evaluate(() => (window as any).__ptyCalls[0])
    expect(
      pasteCall?.data.endsWith('\n'),
      `paste mode data should NOT end with \\n but was: ${JSON.stringify(pasteCall?.data.slice(-20))}`,
    ).toBe(false)

    // Step 8 — AUTO-FIRE mode: re-open modal, leave default sendMode, click Send.
    await win.locator('button:has-text("Use prompt")').click({ force: true })
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // This prompt's seed sendMode is auto-fire, so the radio should already be set.
    await expect(modal.locator('input[type="radio"][value="auto-fire"]')).toBeChecked()

    await sendBtn.click({ force: true })
    await expect(modal).toHaveCount(0, { timeout: 3_000 })

    await win.waitForFunction(() => (window as any).__ptyCalls.length >= 2)

    const autoFireCall = await win.evaluate(() => (window as any).__ptyCalls[1])
    expect(
      autoFireCall?.data.endsWith('\n'),
      `auto-fire mode data should end with \\n but was: ${JSON.stringify(autoFireCall?.data.slice(-20))}`,
    ).toBe(true)
  } finally {
    await app.close()
  }
})

// ─── T5 ──────────────────────────────────────────────────────────────────────

test('Edit root template persists after navigate-away and back', async () => {
  const { app, win } = await launchApp()
  try {
    await navigateToTab(win, 'prompts')

    // Select the Security prompt we'll edit.
    const promptTitle = 'Review staged diff for OWASP Top 10 issues'
    const promptBtn = win.locator(`button:has-text("${promptTitle}")`)
    await expect(promptBtn).toBeVisible({ timeout: 10_000 })
    await promptBtn.click({ force: true })   // force: LeftNav badge poller shifts layout

    // Wait for detail panel to load.
    await expect(win.locator('pre').first()).toBeVisible({ timeout: 5_000 })

    // Enter edit mode.
    await win.locator('button:has-text("Edit root template")').click({ force: true })

    // The EditPane textarea should now be visible.
    const editTextarea = win.locator('textarea[aria-label="Edit prompt body"]')
    await expect(editTextarea).toBeVisible({ timeout: 5_000 })

    // Append the test marker — makes the draft dirty.
    const original = await editTextarea.inputValue()
    await editTextarea.fill(original + ' // EDITED-BY-TEST')

    // Wait for the SaveBar's Save button to become enabled (dirty=true, busy=false).
    const saveBtn = win.locator('button:has-text("Save")')
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 })
    await saveBtn.click({ force: true })

    // After save, editMode turns off and the detail pane re-renders with the
    // updated body. The SaveBar should disappear.
    await expect(editTextarea).toHaveCount(0, { timeout: 5_000 })

    // Navigate away to a different tab, then back to prompts.
    await navigateToTab(win, 'overview')
    await navigateToTab(win, 'prompts')

    // After remount, Prompts selects seedPrompts[0] by default. We need to
    // re-click the Security prompt to trigger loadEffective on the override.
    await expect(promptBtn).toBeVisible({ timeout: 10_000 })
    await promptBtn.click({ force: true })

    // loadEffective reads the override file via IPC — wait for the body to
    // appear and contain our marker. toContainText waits up to default timeout.
    const bodyPre = win.locator('pre').first()
    await expect(bodyPre).toContainText('// EDITED-BY-TEST', { timeout: 10_000 })
  } finally {
    await app.close()
  }
  // afterEach cleans up OVERRIDE_PATH.
})
