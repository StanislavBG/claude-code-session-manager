import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { installOrtFetchTap, ortWasmFilesLoaded } from '../../src/renderer/lib/ortWasmProbe'

const root = path.resolve(__dirname, '../..')
const vadDir = path.join(root, 'src/renderer/public/vad')
const ortDist = path.join(root, 'node_modules/onnxruntime-web/dist')
const ortWasm = (dir: string) => fs.readdirSync(dir).filter((f) => f.startsWith('ort-wasm')).sort()

describe('vendored VAD ort-wasm assets', () => {
  it('are byte-identical to node_modules/onnxruntime-web/dist (run `npm run refresh:vad-assets` after a version bump)', () => {
    const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/onnxruntime-web/package.json'), 'utf8')).version
    const vendored = ortWasm(vadDir)
    expect(vendored.length).toBeGreaterThan(0)
    const drifted = vendored.filter((f) => {
      const src = path.join(ortDist, f)
      return !fs.existsSync(src) || !fs.readFileSync(src).equals(fs.readFileSync(path.join(vadDir, f)))
    })
    expect(drifted, `vendored ort-wasm drifted from onnxruntime-web@${installed}: ${drifted.join(', ')}`).toEqual([])
    expect(ortWasm(ortDist)).toEqual(vendored)
  })
})

describe('ortWasmFilesLoaded', () => {
  it('names the file, not the base URL', () => {
    const got = ortWasmFilesLoaded([
      { name: 'file:///app/dist/vad/ort-wasm-simd-threaded.wasm' },
      { name: 'http://x/vad/ort-wasm-simd-threaded.mjs?v=1' },
      { name: 'http://x/vad/silero_vad_v5.onnx' },
    ])
    expect(got).toEqual(['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'])
  })
})

describe('installOrtFetchTap', () => {
  it('records ort-wasm fetches (file:// has no Resource Timing) and passes through', async () => {
    const calls: string[] = []
    const fake = { fetch: async (u: string) => { calls.push(u); return 'ok' } }
    ;(globalThis as unknown as { window: unknown }).window = fake
    installOrtFetchTap()
    await (fake.fetch as (u: string) => Promise<string>)('file:///app/dist/vad/ort-wasm-simd-threaded.wasm')
    await (fake.fetch as (u: string) => Promise<string>)('file:///app/dist/vad/silero_vad_v5.onnx')
    expect(calls).toHaveLength(2)
    expect(ortWasmFilesLoaded([])).toEqual(['ort-wasm-simd-threaded.wasm'])
    delete (globalThis as unknown as { window?: unknown }).window
  })
})
