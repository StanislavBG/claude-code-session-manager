// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useThrottledValue } from '../useThrottledValue'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('useThrottledValue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function harness() {
    const seen: string[] = []
    const el = document.createElement('div')
    const root = createRoot(el)
    function Probe({ v, on }: { v: string; on: boolean }) {
      seen.push(useThrottledValue(v, 100, on))
      return null
    }
    const render = (v: string, on = true) => act(() => root.render(createElement(Probe, { v, on })))
    return { seen, render, root }
  }

  it('holds intermediate values and emits the last one on the trailing edge', () => {
    const { seen, render } = harness()
    render('a')
    render('ab')
    render('abc')
    expect(seen[seen.length - 1]).toBe('a')
    act(() => { vi.advanceTimersByTime(100) })
    expect(seen[seen.length - 1]).toBe('abc')
    expect(seen).not.toContain('ab')
  })

  it('passes the value straight through when disabled', () => {
    const { seen, render } = harness()
    render('a')
    render('final', false)
    expect(seen[seen.length - 1]).toBe('final')
  })
})
