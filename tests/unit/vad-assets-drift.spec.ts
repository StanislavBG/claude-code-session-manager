import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { installOrtFetchTap, ortWasmFilesLoaded } from '../../src/renderer/lib/ortWasmProbe'

const root = path.resolve(__dirname, '../..')
const vadDir = path.join(root, 'src/renderer/public/vad')
const ortDist = path.join(root, 'node_modules/onnxruntime-web/dist')
const ortWasm = (dir: string) => fs.readdirSync(dir).filter((f) => f.startsWith('ort-wasm')).sort()

// @ricky0123/vad-web imports `onnxruntime-web/wasm`, which resolves to this
// bundle — it references only the simd-threaded pair, so only that pair
// needs to be vendored.
const RESOLVED_ORT_BUNDLE = path.join(root, 'node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs')
const VENDORED_SET = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']

describe('vendored VAD ort-wasm assets', () => {
  it('are byte-identical to node_modules/onnxruntime-web/dist (run `npm run refresh:vad-assets` after a version bump)', () => {
    const vendored = ortWasm(vadDir)
    expect(vendored.length).toBeGreaterThan(0)
    const drifted = vendored.filter((f) => {
      const src = path.join(ortDist, f)
      return !fs.existsSync(src) || !fs.readFileSync(src).equals(fs.readFileSync(path.join(vadDir, f)))
    })
    expect(drifted, `vendored ort-wasm drifted from onnxruntime-web: ${drifted.join(', ')}`).toEqual([])
  })

  it('vendors exactly the simd-threaded pair, not every ort-wasm variant', () => {
    expect(ortWasm(vadDir)).toEqual(VENDORED_SET)
  })

  it('the onnxruntime-web module VAD resolves references no dropped jsep/jspi/asyncify filename', () => {
    const bundle = fs.readFileSync(RESOLVED_ORT_BUNDLE, 'utf8')
    const referencedWasmFiles = [...new Set([...bundle.matchAll(/ort-wasm[^"'/]*\.(?:wasm|mjs)/g)].map((m) => m[0]))].sort()
    expect(referencedWasmFiles).toEqual(VENDORED_SET)
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
