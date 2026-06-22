import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const config = require('../../src/main/config.cjs') as {
  readJson: (p: string) => Promise<{ exists: boolean; error: string | null }>
  readText: (p: string) => Promise<{ exists: boolean; error: string | null }>
  listDir: (p: string) => Promise<{ ok: boolean; error: string | null }>
  exists: (p: string) => Promise<boolean>
}

// Regression: a Claude session running outside the home dir (e.g. macOS /tmp ->
// /private/tmp) made the renderer poll project-metadata reads for paths outside
// allowedRoots. validatePath used to throw *outside* the try/catch, so the
// boundary error escaped through the IPC layer and spammed
// "Error occurred in handler for 'config:read-*'". These auto-polled read
// handlers must DEGRADE to a structured result, never throw.
const OUT_OF_BOUNDS = '/private/tmp/package.json'
const OUT_OF_BOUNDS_DIR = '/private/tmp'

describe('config read handlers — out-of-bounds path must not throw', () => {
  it('readJson returns {exists:false, error} instead of throwing', async () => {
    const r = await config.readJson(OUT_OF_BOUNDS)
    expect(r.exists).toBe(false)
    expect(r.error).toMatch(/outside allowed boundaries/)
  })

  it('readText returns {exists:false, error} instead of throwing', async () => {
    const r = await config.readText(OUT_OF_BOUNDS)
    expect(r.exists).toBe(false)
    expect(r.error).toMatch(/outside allowed boundaries/)
  })

  it('listDir returns {ok:false, error} instead of throwing', async () => {
    const r = await config.listDir(OUT_OF_BOUNDS_DIR)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/outside allowed boundaries/)
  })

  it('exists returns false instead of throwing', async () => {
    await expect(config.exists(OUT_OF_BOUNDS)).resolves.toBe(false)
  })
})
