/**
 * E2E regression test for the microphone feature.
 *
 * Launches Electron with Chromium fake-audio-capture replacing the physical
 * mic by a 48kHz/stereo/s16 WAV loop ("testing one two three four five").
 * Clicks the mic button, waits for Whisper to transcribe, and asserts that
 * at least one keyword from the phrase landed in the active xterm.
 *
 * Prerequisite: `xvfb-run` on PATH. Run via `npm run test:e2e:mic`.
 */
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const FIXTURE_WAV = path.join(__dirname, 'fixtures', 'speech.wav')
const USER_DATA_DIR = path.join(__dirname, '.cache', 'userdata')
const TABS_JSON = path.join(process.env.HOME, '.config', 'session-manager', 'tabs.json')

const KEYWORDS = ['testing', 'test', 'one', 'two', 'three', 'four', 'five']

test.beforeEach(() => {
  if (!fs.existsSync(FIXTURE_WAV)) {
    throw new Error(`Fixture missing: ${FIXTURE_WAV}. Run: npm run test:e2e:gen-fixture`)
  }
  if (fs.existsSync(TABS_JSON)) {
    fs.copyFileSync(TABS_JSON, TABS_JSON + '.bak')
    fs.unlinkSync(TABS_JSON)
  }
  fs.mkdirSync(USER_DATA_DIR, { recursive: true })
})

test.afterEach(() => {
  if (fs.existsSync(TABS_JSON + '.bak')) {
    fs.copyFileSync(TABS_JSON + '.bak', TABS_JSON)
    fs.unlinkSync(TABS_JSON + '.bak')
  }
})

test('mic button transcribes fake audio into the active terminal', async () => {
  const app = await electron.launch({
    args: [
      path.join(ROOT, 'src', 'main', 'index.cjs'),
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${FIXTURE_WAV}`,
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${USER_DATA_DIR}`,
    ],
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'development', SM_E2E: '1' },
    timeout: 30_000,
  })

  const win = await app.firstWindow()
  const logs = []
  win.on('console', (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`
    logs.push(line)
    if (process.env.SM_E2E_DEBUG) console.log(line)
  })

  await win.waitForSelector('text=Claude Session Manager', { timeout: 20_000 })

  // Default tab auto-creates on fresh launch (App.tsx:37-64).
  await win.waitForSelector('.bg-green-500', { timeout: 20_000 })

  // voice.ts seeds window.__transcripts; we assert on that so the test
  // doesn't depend on claude's alt-screen TUI echoing input back to xterm.

  // Wait for the Whisper model to finish downloading. VoiceButton triggers
  // initModel() on mount; model download (~75MB) takes 20-90s on first run,
  // subsequent runs resolve from the persisted userDataDir/IndexedDB cache.
  const modelDeadline = Date.now() + 240_000
  let lastStatus = null
  while (Date.now() < modelDeadline) {
    const state = await win.evaluate(() => {
      const v = /** @type {any} */ (window).__voice
      return v ? v.getState() : null
    })
    if (state && state.modelStatus !== lastStatus) {
      console.log(`[test] voice state: modelStatus=${state.modelStatus} error=${state.error ?? 'none'}`)
      lastStatus = state?.modelStatus
    }
    if (state?.modelStatus === 'ready') break
    if (state?.modelStatus === 'error') throw new Error(`Whisper model failed to load: ${state.error}`)
    await win.waitForTimeout(1000)
  }
  if (lastStatus !== 'ready') {
    console.log('--- renderer logs on timeout ---')
    console.log(logs.slice(-120).join('\n'))
    throw new Error(`Model did not reach ready state (last: ${lastStatus})`)
  }

  // Click the mic button to start recording.
  const micButton = win.locator('[data-testid="mic-button"]')
  await expect(micButton).toBeVisible({ timeout: 10_000 })
  await micButton.click()

  // isRecording flips true in the zustand store; overlay shows "Recording…".
  await win.waitForFunction(
    () => /** @type {any} */ (window).__voice?.getState().isRecording === true,
    null,
    { timeout: 10_000, polling: 250 },
  )

  // Keep recording open until at least one transcript arrives. Stopping
  // early causes speechRecognition.destroy() to remove the worker listener
  // before the in-flight inference completes — the result is discarded.
  // So poll __transcripts; once we have a matching keyword, stop and assert.
  const deadline = Date.now() + 60_000
  let transcripts = []
  let combined = ''
  while (Date.now() < deadline) {
    transcripts = await win.evaluate(() =>
      /** @type {any} */ (window).__transcripts ?? [],
    )
    combined = transcripts.map((t) => t?.text ?? '').join(' ')
    if (KEYWORDS.some((k) => combined.toLowerCase().includes(k))) break
    await win.waitForTimeout(500)
  }

  // Best-effort stop (result already captured above).
  await micButton.click({ timeout: 5_000 }).catch(() => {})

  const finalState = await win.evaluate(() =>
    /** @type {any} */ (window).__voice?.getState() ?? null,
  )
  console.log('[test] final voice state:', JSON.stringify({
    isRecording: finalState?.isRecording,
    modelStatus: finalState?.modelStatus,
    error: finalState?.error,
    lastTranscript: finalState?.lastTranscript,
  }))
  console.log('[test] transcripts:', JSON.stringify(transcripts))

  if (!KEYWORDS.some((k) => combined.toLowerCase().includes(k))) {
    console.log('--- renderer logs (all) ---')
    console.log(logs.join('\n'))
  }

  expect(
    KEYWORDS.some((k) => combined.toLowerCase().includes(k)),
    `Expected transcripts to contain one of [${KEYWORDS.join(', ')}]. Got: ${JSON.stringify(transcripts)}`,
  ).toBe(true)

  await app.close()
})
