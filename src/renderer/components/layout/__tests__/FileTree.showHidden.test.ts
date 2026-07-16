// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { loadShowHidden, SHOW_HIDDEN_KEY } from '../FileTree'

describe('FileTree showHidden hydrate', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to true when never set', () => {
    expect(loadShowHidden()).toBe(true)
  })

  it('honors an explicitly stored false', () => {
    localStorage.setItem(SHOW_HIDDEN_KEY, JSON.stringify(false))
    expect(loadShowHidden()).toBe(false)
  })

  it('honors an explicitly stored true', () => {
    localStorage.setItem(SHOW_HIDDEN_KEY, JSON.stringify(true))
    expect(loadShowHidden()).toBe(true)
  })
})
