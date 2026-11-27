import { test, expect, chromium } from '@playwright/test'
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureWebCss } from './webCss.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Real Chromium (never Electron). Mounts the real SettingsRemoteServices over a stub window.api whose
// servicesList returns one paired service with the grant for the scene. Scenes: off, all,
// selected-pending (choose "Selected projects", nothing ticked), selected-saved.
// Output: test-results/services-start-work/ (gitignored).
const root = path.resolve(__dirname, '../..')
const OUT = path.join(root, 'test-results/services-start-work')
const VIEWPORT = { width: 900, height: 700 }
const SCENES: { scene: string; note: string }[] = [
  { scene: 'off', note: 'Work it opens waits for your approval.' },
  { scene: 'all', note: 'Work it opens in any project starts without a second approval.' },
  { scene: 'selected-pending', note: 'Tick at least one project; until then nothing is granted.' },
  { scene: 'selected-saved', note: 'Work it opens starts without a second approval in 1 project.' },
]
const PNGS = SCENES.flatMap((s) => (['light', 'dark'] as const).map((c) => `${s.scene}-${c}.png`))

const ENTRY = String.raw`
import { createRoot } from 'react-dom/client'
import { SettingsRemoteServices } from '../../src/renderer/components/tabs/SettingsRemoteServices'
import { useSessions } from '../../src/renderer/state/sessions'

const scene = new URLSearchParams(location.search).get('scene') || 'off'
const targets = scene === 'all' ? ['*'] : scene === 'selected-saved' ? ['/home/u/Other'] : null
const svc = {
  serviceId: 'svc-1', name: 'Kiln', homeCwd: '/home/u/Self', scope: ['feedback_open_session'],
  projectRoot: null, relayClientId: 'rc-1', pairedAt: 1700000000000, lastSeenAt: 1700000000000,
  startWork: targets ? { targets } : null,
}
useSessions.setState({ tabs: [{ id: 't1', cwd: '/home/u/Self' }, { id: 't2', cwd: '/home/u/Other' }] })

const api = {
  webRemote: {
    servicesList: async () => ({ ok: true, services: [svc], pending: [], relayOrphans: [] }),
    serviceSetStartWork: async () => ({ ok: true, service: svc }),
  },
  app: { homeDir: async () => '/home/u/' },
  clipboard: { writeText: async () => ({ ok: true }) },
}
function fallback(target, p) {
  return new Proxy(target, {
    get(t, k) {
      if (typeof k === 'symbol' || k in t) {
        const v = t[k]
        return v && typeof v === 'object' ? fallback(v, p + '.' + String(k)) : v
      }
      console.log('[stub-api] ' + (p + '.' + String(k)).replace(/^\./, ''))
      return fallback(async () => undefined, p + '.' + String(k))
    },
  })
}
window.api = fallback(api, '')

createRoot(document.getElementById('root')).render(
  <div style={{ padding: 24 }} className="text-fg">
    <SettingsRemoteServices enabled={true} hasDevice={true} />
  </div>,
)
`

test('Services start-work control: off / all / selected-pending / selected-saved; light + dark', async () => {
  const css = ensureWebCss(root)
  const bundle = (await build({
    stdin: { contents: ENTRY, resolveDir: __dirname, sourcefile: 'services-start-work-entry.jsx', loader: 'jsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0"' },
  })).outputFiles[0].text

  fs.mkdirSync(OUT, { recursive: true })
  for (const f of PNGS) fs.rmSync(path.join(OUT, f), { force: true }) // a stale PNG must not pass
  const errors: string[] = []
  const browser = await chromium.launch() // never Electron
  try {
    for (const scheme of ['light', 'dark'] as const) {
      for (const { scene, note } of SCENES) {
        const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: scheme })
        const page = await ctx.newPage()
        const tag = `${scene}/${scheme}`
        page.on('pageerror', (e) => errors.push(`${tag}: pageerror ${e.message}`))
        page.on('console', (m) => { if (m.text().startsWith('[stub-api]')) errors.push(`${tag}: ${m.text()}`) })
        await page.route('http://fx.test/**', (r) =>
          r.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${css}</style></head><body class="bg-bg"><div id="root"></div></body></html>` }),
        )
        await page.goto(`http://fx.test/?scene=${scene}`)
        await page.addScriptTag({ content: bundle })
        if (scheme === 'dark') await page.addStyleTag({ content: 'html{filter:invert(1) hue-rotate(180deg)}' })
        const mode = page.getByTestId('remote-service-start-work-mode')
        await expect(mode).toBeVisible()
        if (scene === 'selected-pending') await mode.selectOption('selected')
        await expect(page.getByTestId('remote-service-start-work-note')).toHaveText(note)
        await page.waitForTimeout(250)
        await page.screenshot({ path: path.join(OUT, `${scene}-${scheme}.png`) })
        await ctx.close()
      }
    }
  } finally {
    await browser.close()
  }
  expect(errors, 'page errors or unmodelled api calls').toEqual([])
  for (const f of PNGS) {
    const file = path.join(OUT, f)
    expect(fs.existsSync(file), file).toBe(true)
    expect(fs.statSync(file).size, file).toBeGreaterThan(1024)
  }
})
