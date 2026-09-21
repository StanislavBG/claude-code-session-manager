import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'

const requireCjs = createRequire(import.meta.url)
const rr = requireCjs('../../src/main/lib/rendererRecovery.cjs')

function harness() {
  let t = 0
  const policy = rr.createReloadPolicy({ now: () => t })
  const wc: any = new EventEmitter()
  wc.isDestroyed = () => false
  wc.reload = vi.fn()
  const timers: { fn: () => void; cancelled: boolean }[] = []
  const delays: number[] = []
  const lines: any[] = []
  rr.attachRendererRecovery(wc, {
    logs: { writeLine: (l: any) => lines.push(l) },
    policy,
    setTimer: (fn: () => void, ms: number) => { delays.push(ms); const h = { fn, cancelled: false }; timers.push(h); return h },
    clearTimer: (h: any) => { h.cancelled = true },
  })
  const fire = () => timers.filter((x) => !x.cancelled).forEach((x) => { x.cancelled = true; x.fn() })
  return { wc, policy, lines, timers, delays, fire, advance: (ms: number) => { t += ms } }
}

describe('rendererRecovery', () => {
  it('reloads on crash, caps at 3 per 10 min with one error line, window expiry re-allows', () => {
    const h = harness()
    for (let i = 0; i < 5; i++) h.wc.emit('render-process-gone', {}, { reason: 'oom' })
    expect(h.wc.reload).toHaveBeenCalledTimes(3)
    expect(h.lines.filter((l) => l.level === 'error')).toHaveLength(1)
    expect(h.lines.find((l) => l.level === 'error').meta.reason).toContain('oom')
    h.advance(rr.WINDOW_MS + 1)
    h.wc.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(h.wc.reload).toHaveBeenCalledTimes(4)
  })

  it('ignores clean-exit', () => {
    const h = harness()
    h.wc.emit('render-process-gone', {}, { reason: 'clean-exit' })
    expect(h.wc.reload).not.toHaveBeenCalled()
  })

  it('unresponsive force-crashes after grace; responsive cancels; fallback reloads', () => {
    const h = harness()
    h.wc.forcefullyCrashRenderer = vi.fn()
    h.wc.emit('unresponsive')
    h.wc.emit('responsive')
    h.fire()
    expect(h.wc.forcefullyCrashRenderer).not.toHaveBeenCalled()
    h.wc.emit('unresponsive')
    expect(h.delays.at(-1)).toBe(rr.UNRESPONSIVE_GRACE_MS)
    expect(rr.UNRESPONSIVE_GRACE_MS).toBe(30000)
    h.fire()
    expect(h.wc.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
    expect(h.wc.reload).not.toHaveBeenCalled()
    expect(h.lines.some((l) => l.scope === 'crash-diag' && l.message === 'renderer unresponsive')).toBe(true)
  })

  it('hang recovery consumes exactly one cap slot', () => {
    const h = harness()
    h.wc.forcefullyCrashRenderer = vi.fn(() => h.wc.emit('render-process-gone', {}, { reason: 'killed' }))
    h.wc.emit('unresponsive')
    h.fire()
    expect(h.wc.reload).toHaveBeenCalledTimes(1)
    h.wc.emit('render-process-gone', {}, { reason: 'crashed' })
    h.wc.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(h.wc.reload).toHaveBeenCalledTimes(3)
    expect(h.lines.filter((l) => l.level === 'error')).toHaveLength(0)
  })

  it('hang with cap exhausted does not force-crash; logs one error line', () => {
    const h = harness()
    h.wc.forcefullyCrashRenderer = vi.fn()
    for (let i = 0; i < 3; i++) h.wc.emit('render-process-gone', {}, { reason: 'oom' })
    h.wc.emit('unresponsive')
    h.fire()
    expect(h.wc.forcefullyCrashRenderer).not.toHaveBeenCalled()
    expect(h.lines.filter((l) => l.level === 'error')).toHaveLength(1)
  })

  it('hang falls back to reload when forcefullyCrashRenderer is missing or throws', () => {
    const h = harness()
    h.wc.emit('unresponsive')
    h.fire()
    expect(h.wc.reload).toHaveBeenCalledTimes(1)
    h.wc.forcefullyCrashRenderer = vi.fn(() => { throw new Error('boom') })
    h.wc.emit('unresponsive')
    h.fire()
    expect(h.wc.reload).toHaveBeenCalledTimes(2)
  })

  it('did-fail-load: ignores ERR_ABORTED and subframes; retries once, counted against cap', () => {
    const h = harness()
    h.wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'x', true)
    h.wc.emit('did-fail-load', {}, -105, 'NAME', 'x', false)
    h.fire()
    expect(h.wc.reload).not.toHaveBeenCalled()
    h.wc.emit('did-fail-load', {}, -105, 'NAME', 'x', true)
    h.wc.emit('did-fail-load', {}, -105, 'NAME', 'x', true)
    expect(h.delays).toEqual([rr.LOAD_RETRY_DELAY_MS])
    expect(rr.LOAD_RETRY_DELAY_MS).toBe(2000)
    h.fire()
    expect(h.wc.reload).toHaveBeenCalledTimes(1)
    h.wc.emit('render-process-gone', {}, { reason: 'oom' })
    h.wc.emit('render-process-gone', {}, { reason: 'oom' })
    h.wc.emit('render-process-gone', {}, { reason: 'oom' })
    expect(h.wc.reload).toHaveBeenCalledTimes(3)
  })

  it('policy is pure with injected clock', () => {
    let t = 0
    const p = rr.createReloadPolicy({ now: () => t, max: 1, windowMs: 100 })
    expect(p.tryReload()).toBe(true)
    expect(p.tryReload()).toBe(false)
    t = 100
    expect(p.tryReload()).toBe(true)
  })
})
