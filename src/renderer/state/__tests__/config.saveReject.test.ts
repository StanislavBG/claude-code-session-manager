import { test, expect, vi, beforeEach } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as any).window = (globalThis as any).window ?? globalThis
})

const api = {
  config: {
    readJson: vi.fn(),
    readText: vi.fn(),
    writeJson: vi.fn(),
    writeText: vi.fn(),
  },
}

beforeEach(() => {
  ;(globalThis as any).window.api = api
  vi.clearAllMocks()
})

async function loaded(path: string, kind: 'json' | 'text') {
  const { useConfig } = await import('../config')
  const mtime = { exists: true, mtimeMs: 1, raw: '{}', data: {}, parseError: null }
  api.config.readJson.mockResolvedValue(mtime)
  api.config.readText.mockResolvedValue({ exists: true, mtimeMs: 1, raw: 'x' })
  if (kind === 'json') await useConfig.getState().loadJson(path)
  else await useConfig.getState().loadText(path)
  return useConfig
}

test('rejecting writeJson yields ok:false and busy:false', async () => {
  const useConfig = await loaded('/p/.mcp.json', 'json')
  api.config.writeJson.mockRejectedValue(new Error('boom'))
  const r = await useConfig.getState().saveJson('/p/.mcp.json', { force: true })
  expect(r).toEqual({ ok: false, error: 'boom' })
  expect(useConfig.getState().files['/p/.mcp.json'].busy).toBe(false)
})

test('rejecting writeText yields ok:false and busy:false', async () => {
  const useConfig = await loaded('/p/a.md', 'text')
  api.config.writeText.mockRejectedValue(new Error('nope'))
  const r = await useConfig.getState().saveText('/p/a.md', { force: true })
  expect(r).toEqual({ ok: false, error: 'nope' })
  expect(useConfig.getState().files['/p/a.md'].busy).toBe(false)
})
