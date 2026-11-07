// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useEffectiveSettingsFor, readLeafWithSource } from '../useEffectiveSettings'
import { installConfigChangeListener } from '../../state/config'

const HOME = '/home/test'
const USER_FILE = `${HOME}/.claude/settings.json`

let disk: Record<string, string> = {}
let emit: (info: { path: string }) => void = () => {}
let root: Root | null = null
let seen: string | null = null

function readJson(path: string) {
  const raw = disk[path]
  if (raw === undefined) {
    return Promise.resolve({ exists: false, raw: '', data: null, parseError: null, mtimeMs: 0 })
  }
  return Promise.resolve({ exists: true, raw, data: JSON.parse(raw), parseError: null, mtimeMs: Date.now() })
}

function Probe() {
  const node = useEffectiveSettingsFor('/proj')
  seen = readLeafWithSource(node, ['model']).value
  return null
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  disk = { [USER_FILE]: JSON.stringify({ model: 'sonnet' }) }
  ;(window as unknown as { api: unknown }).api = {
    app: { homeDir: () => Promise.resolve(HOME) },
    config: {
      readJson: vi.fn(readJson),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: (h: (info: { path: string }) => void) => {
        emit = h
        return () => {}
      },
    },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  seen = null
})

describe('useEffectiveSettingsFor', () => {
  it('updates the merged value on an external config:changed for the user file', async () => {
    installConfigChangeListener()
    root = createRoot(document.createElement('div'))
    act(() => root!.render(<Probe />))
    await flush()
    await flush()
    expect(seen).toBe('sonnet')

    disk[USER_FILE] = JSON.stringify({ model: 'opus' })
    act(() => emit({ path: USER_FILE }))
    await flush()
    expect(seen).toBe('opus')
  })
})
