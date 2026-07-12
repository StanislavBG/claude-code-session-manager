import { describe, it, expect, beforeEach } from 'vitest'
import { useToast, toast } from '../toast'

/**
 * toast.fromOutcome is a thin wrapper over show() that maps an
 * ActionOutcome's `kind ?? (ok ? 'info' : 'warn')`. These tests cover
 * only that mapping, not show()'s dedup/cap/history behavior.
 */

describe('toast.fromOutcome', () => {
  beforeEach(() => {
    useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  })

  it('uses explicit kind: error', () => {
    const id = toast.fromOutcome({ ok: false, kind: 'error', message: 'boom' })
    const entry = useToast.getState().toasts.find((t) => t.id === id)
    expect(entry).toMatchObject({ kind: 'error', message: 'boom' })
  })

  it('uses explicit kind: warn', () => {
    const id = toast.fromOutcome({ ok: false, kind: 'warn', message: 'careful' })
    const entry = useToast.getState().toasts.find((t) => t.id === id)
    expect(entry).toMatchObject({ kind: 'warn', message: 'careful' })
  })

  it('uses explicit kind: info', () => {
    const id = toast.fromOutcome({ ok: true, kind: 'info', message: 'done' })
    const entry = useToast.getState().toasts.find((t) => t.id === id)
    expect(entry).toMatchObject({ kind: 'info', message: 'done' })
  })

  it('defaults to info when ok is true and kind is omitted', () => {
    const id = toast.fromOutcome({ ok: true, message: 'ticked' })
    const entry = useToast.getState().toasts.find((t) => t.id === id)
    expect(entry).toMatchObject({ kind: 'info', message: 'ticked' })
  })

  it('defaults to warn when ok is false and kind is omitted', () => {
    const id = toast.fromOutcome({ ok: false, message: 'nothing to do' })
    const entry = useToast.getState().toasts.find((t) => t.id === id)
    expect(entry).toMatchObject({ kind: 'warn', message: 'nothing to do' })
  })

  it('returns a non-empty toast id, matching show()\'s contract', () => {
    const id = toast.fromOutcome({ ok: true, message: 'ok' })
    expect(id).toBeTruthy()
    expect(typeof id).toBe('string')
  })
})
