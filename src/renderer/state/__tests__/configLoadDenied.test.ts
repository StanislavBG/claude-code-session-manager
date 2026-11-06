import { describe, expect, it, vi } from 'vitest'

const readJson = vi.fn(async () => { throw new Error('Not available in the web version') })
;(globalThis as any).window = { api: { config: { readJson, readText: vi.fn(), watch: vi.fn(), unwatch: vi.fn() } } }

import { useConfig } from '../config'

describe('config.loadJson when the read is denied (web UI)', () => {
  it('resolves and records the denial as loadError instead of rejecting', async () => {
    await expect(useConfig.getState().loadJson('/x/settings.json')).resolves.toBeUndefined()
    const f = useConfig.getState().files['/x/settings.json']
    expect(f.busy).toBe(false)
    expect(f.loadError).toBe('Not available in the web version')
  })
})
