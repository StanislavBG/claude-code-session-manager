/**
 * A losing single-instance-lock process must actually terminate, not just
 * request a quit. app.quit() before app.whenReady() has no window/IPC to
 * hook the normal quit-event chain into and can leave a zombie process
 * running indefinitely (found live: three orphaned instances over a day).
 *
 * Source: src/main/lib/singleInstanceGuard.cjs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { terminateLosingInstance } = require('../../src/main/lib/singleInstanceGuard.cjs')

describe('terminateLosingInstance', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('calls app.exit(0), never app.quit()', () => {
    const app = { exit: vi.fn(), quit: vi.fn() }
    terminateLosingInstance(app)
    expect(app.exit).toHaveBeenCalledWith(0)
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('registers a process.exit(0) backstop that fires if app.exit is delayed', () => {
    vi.useFakeTimers()
    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const app = { exit: vi.fn(), quit: vi.fn() }

    terminateLosingInstance(app, { fallbackDelayMs: 2000 })

    expect(processExitSpy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000)
    expect(processExitSpy).toHaveBeenCalledWith(0)
  })
})
