import { test, expect, chromium } from '@playwright/test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const __filename = fileURLToPath(import.meta.url)

// Real Chromium (never Electron). Renders the real Project Home document
// (ProjectPagesSection) with CSS from the built web renderer (dist-web/app.css) and a stub
// window.api holding 2 knowledge pages + 2 videos; writes 4 PNGs for the validation record.
// The app ships a single light palette, so "dark" = Chromium dark colour-scheme emulation
// plus an inverted render of the same page.
const root = path.resolve(__dirname, '../..')
const OUT = path.join(root, 'session-manager-operations/reviews/validation/project-home-as-a-player-knowledge-pages-video-p-4afa65b6/screens')
const { PLAYER_BRIDGE_SCRIPT } = createRequire(__filename)(path.join(root, 'src/main/lib/project-pages/playerBridge.cjs')) as { PLAYER_BRIDGE_SCRIPT: string }

const videoHtml = (title: string) => `<!doctype html><html><body style="margin:0;background:#1d2733;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><h1 style="font-size:48px">${title}</h1><script>
window.smDemo={duration:30,t:0,playing:false,scenes:[{t:0,label:'Intro'},{t:10,label:'Features'},{t:20,label:'Outro'}],
play(){this.playing=true},pause(){this.playing=false},seek(x){this.t=x},getTime(){return this.t}};
</script><script>${PLAYER_BRIDGE_SCRIPT}</script></body></html>`

test('Project Home screenshots: knowledge + videos, light + dark', async () => {
  if (!fs.existsSync(path.join(root, 'dist-web/app.css'))) {
    execSync('npx vite build --config vite.web.config.ts', { cwd: root, stdio: 'inherit' })
  }
  const css = fs.readFileSync(path.join(root, 'dist-web/app.css'), 'utf8')
  const bundle = (await build({
    entryPoints: [path.join(__dirname, 'project-home-entry.tsx')],
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0"' },
  })).outputFiles[0].text

  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch() // never Electron
  try {
    for (const scheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: scheme })
      const page = await ctx.newPage()
      await page.route('http://fx.test/**', (r) => {
        const u = r.request().url()
        if (u.endsWith('/video-demo-a')) return r.fulfill({ contentType: 'text/html', body: videoHtml('Product tour') })
        if (u.endsWith('/video-demo-b')) return r.fulfill({ contentType: 'text/html', body: videoHtml('Release notes') })
        return r.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${css}</style></head><body class="bg-bg"><div id="root"></div></body></html>` })
      })
      await page.goto('http://fx.test/')
      // smfile:// is a custom scheme Chromium route() cannot serve: point video frames at the fixture instead.
      await page.addScriptTag({ content: `new MutationObserver(()=>{document.querySelectorAll('iframe[src^="smfile://"]').forEach(f=>{const s=f.getAttribute('src');f.setAttribute('src','http://fx.test/video-'+(s.includes('demo-b')?'demo-b':'demo-a'))})}).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['src']})` })
      await page.addScriptTag({ content: bundle })
      if (scheme === 'dark') await page.addStyleTag({ content: 'html{filter:invert(1) hue-rotate(180deg)}' })

      await expect(page.getByTestId('knowledge-page-item')).toHaveCount(2)
      await page.frameLocator('iframe[title]').first().locator('h1').waitFor()
      await page.screenshot({ path: path.join(OUT, `knowledge-${scheme}.png`) })

      await page.locator('[data-page="videos"]').click()
      await expect(page.getByTestId('video-item')).toHaveCount(2)
      await page.frameLocator('iframe').first().locator('h1').waitFor()
      await page.waitForTimeout(500)
      await page.screenshot({ path: path.join(OUT, `videos-${scheme}.png`) })
      await ctx.close()
    }
  } finally {
    await browser.close()
  }
  for (const n of ['knowledge-light', 'knowledge-dark', 'videos-light', 'videos-dark']) {
    expect(fs.statSync(path.join(OUT, `${n}.png`)).size).toBeGreaterThan(10_000)
  }
})
