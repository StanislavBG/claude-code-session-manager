// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useChatPrefs, resolveEpicVerbosity, CHAT_PREFS_FILE } from '../chatPrefs'
import { CHAT_VERBOSITY_DEFAULT } from '../../lib/chatVerbosity'

function installApi(data: unknown, exists = true) {
  const writeJson = vi.fn(async () => ({ ok: true }))
  ;(window as unknown as { api: unknown }).api = {
    config: { readJson: async () => ({ exists, data }), writeJson },
  }
  return writeJson
}

function resetStore() {
  useChatPrefs.setState({ verbosity: CHAT_VERBOSITY_DEFAULT, perEpic: {}, hydrated: false })
}

describe('chatPrefs', () => {
  beforeEach(resetStore)
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('migrates the retired 3-level "verbose" value forward to "raw"', async () => {
    installApi({ verbosity: 'verbose', perEpic: { 'epic-a': 'verbose' } })
    await useChatPrefs.getState().hydrate()
    expect(useChatPrefs.getState().verbosity).toBe('raw')
    expect(useChatPrefs.getState().perEpic['epic-a']).toBe('raw')
  })

  it('drops an unrecognised value rather than persisting it', async () => {
    installApi({ verbosity: 'nonsense', perEpic: { 'epic-a': 'nonsense', 'epic-b': 'detail' } })
    await useChatPrefs.getState().hydrate()
    expect(useChatPrefs.getState().verbosity).toBe(CHAT_VERBOSITY_DEFAULT)
    expect(useChatPrefs.getState().perEpic).toEqual({ 'epic-b': 'detail' })
  })

  it('hydrate is one-shot per session', async () => {
    installApi({ verbosity: 'summary', perEpic: {} })
    await useChatPrefs.getState().hydrate()
    expect(useChatPrefs.getState().verbosity).toBe('summary')
    installApi({ verbosity: 'raw', perEpic: {} })
    await useChatPrefs.getState().hydrate()
    expect(useChatPrefs.getState().verbosity).toBe('summary')
  })

  it('setting an Epic to the current global level CLEARS its override', () => {
    const writeJson = installApi(null, false)
    useChatPrefs.setState({ verbosity: 'standard', perEpic: { 'epic-a': 'raw' } })
    useChatPrefs.getState().setEpicVerbosity('epic-a', 'standard')
    expect(useChatPrefs.getState().perEpic).toEqual({})
    expect(writeJson).toHaveBeenCalledWith(CHAT_PREFS_FILE, { verbosity: 'standard', perEpic: {} })
  })

  it('resolveEpicVerbosity prefers the override, else the global default', () => {
    expect(resolveEpicVerbosity('standard', { 'epic-a': 'raw' }, 'epic-a')).toBe('raw')
    expect(resolveEpicVerbosity('standard', { 'epic-a': 'raw' }, 'epic-b')).toBe('standard')
  })
})
