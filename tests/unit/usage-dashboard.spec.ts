// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const DASHBOARD_DIR = path.resolve(__dirname, '../../session-manager-operations/project-pages/output/dashboard')

async function loadDashboard() {
  vi.resetModules()
  await import(path.join(DASHBOARD_DIR, 'dashboard.js'))
  return (globalThis as any).Dashboard
}

function fixtureData() {
  return JSON.parse(fs.readFileSync(path.join(DASHBOARD_DIR, 'fixture.json'), 'utf8'))
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

describe('usage dashboard — rankIssues', () => {
  it('ranks by distinct installs affected, not raw occurrence count', async () => {
    const Dashboard = await loadDashboard()
    const data = fixtureData()
    const ranked = Dashboard.rankIssues(data.issues)

    const oom = ranked.find((i: any) => i.signature === 'crash.oom|renderer')
    const ipcTimeout = ranked.find((i: any) => i.signature === 'ipc.timeout|scheduler-bridge')

    expect(oom.occurrences).toBe(400)
    expect(oom.installsAffected).toBe(1)
    expect(ipcTimeout.occurrences).toBe(12)
    expect(ipcTimeout.installsAffected).toBe(9)

    const oomRank = ranked.indexOf(oom)
    const ipcRank = ranked.indexOf(ipcTimeout)
    expect(ipcRank).toBeLessThan(oomRank)
  })

  it('breaks ties on installsAffected using occurrences descending', async () => {
    const Dashboard = await loadDashboard()
    const issues = [
      { signature: 'a', installsAffected: 5, occurrences: 10 },
      { signature: 'b', installsAffected: 5, occurrences: 40 },
      { signature: 'c', installsAffected: 8, occurrences: 1 },
    ]
    const ranked = Dashboard.rankIssues(issues)
    expect(ranked.map((i: any) => i.signature)).toEqual(['c', 'b', 'a'])
  })
})

describe('usage dashboard — formatting', () => {
  it('formats generatedAt in America/Los_Angeles with a zone abbreviation', async () => {
    const Dashboard = await loadDashboard()
    const formatted = Dashboard.formatDateTimeLA(1789060000)
    expect(formatted).toMatch(/P[SD]T/)
  })

  it('states the lookback window in words', async () => {
    const Dashboard = await loadDashboard()
    expect(Dashboard.formatWindow(30)).toBe('last 30 days')
  })
})

describe('usage dashboard — states', () => {
  let root: HTMLElement
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>'
    root = document.getElementById('app') as HTMLElement
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('renders loading, then the full dashboard on success', async () => {
    const Dashboard = await loadDashboard()
    const data = fixtureData()
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, data))

    await Dashboard.init(root, { fetchImpl, search: '' })

    expect(root.textContent).toContain('Installs')
    expect(root.textContent).toContain('Usage')
    expect(root.textContent).toContain('Issues to act on')
    expect(root.textContent).toContain('Errors by version')
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('renders issue rows in installsAffected-ranked order in the DOM', async () => {
    const Dashboard = await loadDashboard()
    const data = fixtureData()
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, data))

    await Dashboard.init(root, { fetchImpl, search: '' })

    const signatures = Array.from(root.querySelectorAll('td code')).map((el) => el.textContent)
    const ipcIdx = signatures.indexOf('ipc.timeout|scheduler-bridge')
    const oomIdx = signatures.indexOf('crash.oom|renderer')
    expect(ipcIdx).toBeGreaterThanOrEqual(0)
    expect(oomIdx).toBeGreaterThan(ipcIdx)
  })

  it('renders a plain sign-in message on 401 — never a stack trace', async () => {
    const Dashboard = await loadDashboard()
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, {}))

    await Dashboard.init(root, { fetchImpl, search: '' })

    expect(root.textContent).toMatch(/sign in at bilko\.run\/admin/i)
    expect(root.textContent).not.toMatch(/at .*\.js:\d+/)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('renders a plain sign-in message on 403', async () => {
    const Dashboard = await loadDashboard()
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, {}))

    await Dashboard.init(root, { fetchImpl, search: '' })

    expect(root.textContent).toMatch(/sign in at bilko\.run\/admin/i)
  })

  it('renders a not-deployed message on 404, naming what is expected', async () => {
    const Dashboard = await loadDashboard()
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, {}))

    await Dashboard.init(root, { fetchImpl, search: '' })

    expect(root.textContent).toMatch(/collector endpoint is not live yet/i)
    expect(root.textContent).toContain('/api/admin/session-manager/usage')
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('renders an empty-state message when the endpoint returns no data yet', async () => {
    const Dashboard = await loadDashboard()
    const emptyPayload = {
      generatedAt: 1789060000,
      windowDays: 30,
      installs: { total: 0, active7: 0, active30: 0, new7: 0, byVersion: [], byPlatform: [], specs: {} },
      usage: { daily: [], byVersion: [] },
      issues: [],
      errors: { byVersion: [], daily: [] },
    }
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, emptyPayload))

    await Dashboard.init(root, { fetchImpl, search: '' })

    expect(root.textContent).toMatch(/no data yet/i)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('renders a network-failure message without throwing when fetch rejects', async () => {
    const Dashboard = await loadDashboard()
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(Dashboard.init(root, { fetchImpl, search: '' })).resolves.not.toThrow()
    expect(root.textContent).toMatch(/could not reach the collector/i)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('renders from the fixture when ?fixture=1 is present, bypassing the network endpoint', async () => {
    const Dashboard = await loadDashboard()
    const data = fixtureData()
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      expect(url).not.toContain('/api/admin/session-manager/usage')
      return Promise.resolve(jsonResponse(200, data))
    })

    await Dashboard.init(root, { fetchImpl, search: '?fixture=1' })

    expect(fetchImpl).toHaveBeenCalledWith('./fixture.json')
    expect(root.textContent).toContain('Issues to act on')
  })
})

describe('usage dashboard — charts', () => {
  it('renders at least two inline SVG charts for the fixture data', async () => {
    const Dashboard = await loadDashboard()
    document.body.innerHTML = '<div id="app"></div>'
    const root = document.getElementById('app') as HTMLElement
    const data = fixtureData()

    Dashboard.renderDashboard(root, data)

    const svgCount = (root.innerHTML.match(/<svg/g) || []).length
    expect(svgCount).toBeGreaterThanOrEqual(2)
  })

  it('colors chart marks with the --series CSS custom properties, never a hard-coded hex', async () => {
    const Dashboard = await loadDashboard()
    document.body.innerHTML = '<div id="app"></div>'
    const root = document.getElementById('app') as HTMLElement
    const data = fixtureData()

    Dashboard.renderDashboard(root, data)

    const svgHtml = Array.from(root.querySelectorAll('svg')).map((s) => s.outerHTML).join('\n')
    expect(svgHtml).toMatch(/var\(--series-1\)/)
    expect(svgHtml).toMatch(/var\(--series-2\)/)
    expect(svgHtml).not.toMatch(/#[0-9a-fA-F]{3,6}/)
  })

  it('degrades cleanly with a zero-length daily array — no NaN in the markup, no throw', async () => {
    const Dashboard = await loadDashboard()
    document.body.innerHTML = '<div id="app"></div>'
    const root = document.getElementById('app') as HTMLElement
    const data = fixtureData()
    data.usage.daily = []
    data.errors.daily = []

    expect(() => Dashboard.renderDashboard(root, data)).not.toThrow()
    expect(root.innerHTML).not.toMatch(/NaN/)
  })

  it('degrades cleanly with a single-element daily array — no NaN in the markup, no throw', async () => {
    const Dashboard = await loadDashboard()
    document.body.innerHTML = '<div id="app"></div>'
    const root = document.getElementById('app') as HTMLElement
    const data = fixtureData()
    data.usage.daily = [data.usage.daily[0]]
    data.errors.daily = [data.errors.daily[0]]

    expect(() => Dashboard.renderDashboard(root, data)).not.toThrow()
    expect(root.innerHTML).not.toMatch(/NaN/)
  })
})

describe('usage dashboard — no PII', () => {
  it('the rendered fixture output contains no @-bearing token and no email/user/host field', async () => {
    const Dashboard = await loadDashboard()
    document.body.innerHTML = '<div id="app"></div>'
    const root = document.getElementById('app') as HTMLElement
    const data = fixtureData()

    Dashboard.renderDashboard(root, data)

    expect(root.textContent).not.toMatch(/[^\s]+@[^\s]+/)
    const lowered = root.textContent!.toLowerCase()
    expect(lowered).not.toMatch(/\bemail\b/)
    expect(lowered).not.toMatch(/\busername\b/)
    expect(lowered).not.toMatch(/\bhostname\b/)
    expect(root.querySelectorAll('[data-field="email"], [data-field="user"], [data-field="host"]').length).toBe(0)
  })
})
