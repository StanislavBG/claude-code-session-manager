// Asserts release.yml's load-bearing shape by reading it as text (no YAML dep).
import { describe, it, expect } from 'vitest'
const fs = require('node:fs')
const path = require('node:path')

const yml = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'release.yml'), 'utf8')

describe('release.yml', () => {
  it('triggers on v* tags and workflow_dispatch, never pull_request', () => {
    expect(yml).toMatch(/tags:\s*\['v\*'\]/)
    expect(yml).toContain('workflow_dispatch')
    expect(yml).not.toMatch(/^\s*pull_request/m)
  })
  it('groups concurrency per tag', () => {
    expect(yml).toMatch(/concurrency:\s*\n\s*group: release-\$\{\{ github\.ref \}\}/)
  })
  it('matrixes macos and ubuntu runners with their dist scripts', () => {
    expect(yml).toContain('macos-latest')
    expect(yml).toContain('ubuntu-latest')
    expect(yml).toContain('dist:mac')
    expect(yml).toContain('dist:linux')
    expect(yml).toContain('contents: write')
    expect(yml).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
    expect(yml).toContain('node-version: \'22\'')
    expect(yml).toContain('npm ci')
  })
  it('publishes with --publish always', () => {
    expect(yml).toContain('npm run ${{ matrix.script }} -- --publish always')
    expect(yml).toContain('-c.publish.releaseType=release')
  })
  it('runs the packaged smoke before publishing', () => {
    expect(yml).toContain('SM_PACKAGED_BIN')
    expect(yml).toContain('release/out/mac-arm64/Session Manager.app/Contents/MacOS/Session Manager')
    expect(yml).toContain('xvfb-run')
    expect(yml).toContain('release/out/linux-unpacked/session-manager')
    expect(yml).toContain('npx playwright install --with-deps chromium')
    expect(yml.indexOf('smoke:packaged')).toBeLessThan(yml.indexOf('--publish always'))
  })
  it('falls back to unsigned when CSC_LINK is empty and notarizes only with Apple secrets', () => {
    for (const s of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
      expect(yml).toContain(`secrets.${s}`)
    }
    expect(yml).toContain('CSC_IDENTITY_AUTO_DISCOVERY=false')
    expect(yml).toContain('-c.mac.notarize=true')
  })
  it('matrixes windows-latest with dist:win and smokes the unpacked exe before publishing', () => {
    expect(yml).toContain('os: windows-latest')
    expect(yml).toContain('script: dist:win')
    expect(yml).toContain('release/out/win-unpacked/Session Manager.exe')
    expect(yml.indexOf('release/out/win-unpacked')).toBeLessThan(yml.indexOf('--publish always'))
  })
  it('signs Windows with WIN_CSC_* secrets and falls back to unsigned when absent', () => {
    expect(yml).toContain('secrets.WIN_CSC_LINK')
    expect(yml).toContain('secrets.WIN_CSC_KEY_PASSWORD')
    expect(yml).toContain('Configure Windows signing')
    expect(yml).toMatch(/matrix\.os == 'windows-latest'[\s\S]*?-z "\$WIN_CSC_LINK"/)
    expect(yml).toContain('No WIN_CSC_LINK: building unsigned')
  })
})
