#!/usr/bin/env node
// Derives src/renderer/public/vad/ from the installed dependencies so the
// self-hosted VAD assets can never drift from the ORT JS Vite bundles:
//   ort-wasm-simd-threaded.{wasm,mjs} <- node_modules/onnxruntime-web/dist
//                  (the only variant onnxruntime-web/wasm's bundle references;
//                  @ricky0123/vad-web imports that subpath)
//   silero/worklet <- node_modules/@ricky0123/vad-web/dist
// Guarded by tests/unit/vad-assets-drift.spec.ts. Complexity: O(files).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dest = path.join(root, 'src/renderer/public/vad')
const ortDist = path.join(root, 'node_modules/onnxruntime-web/dist')
const vadDist = path.join(root, 'node_modules/@ricky0123/vad-web/dist')

const ortFiles = fs.readdirSync(ortDist).filter((f) => /^ort-wasm-simd-threaded\.(wasm|mjs)$/.test(f))
if (ortFiles.length === 0) {
  console.error(`HALT: no ort-wasm-simd-threaded.* files in ${ortDist} — run npm install`)
  process.exit(1)
}
fs.mkdirSync(dest, { recursive: true })
for (const f of ortFiles) fs.copyFileSync(path.join(ortDist, f), path.join(dest, f))
for (const f of ['silero_vad_v5.onnx', 'vad.worklet.bundle.min.js']) {
  fs.copyFileSync(path.join(vadDist, f), path.join(dest, f))
}
const version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/onnxruntime-web/package.json'), 'utf8')).version
console.log(`refreshed ${ortFiles.length} ort-wasm files from onnxruntime-web@${version} + vad-web assets`)
