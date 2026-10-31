import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'))
const stub = (f: string) => path.resolve(__dirname, 'src/renderer/web/stubs', f)

// Stubs: voice (speechRecognition, whisperWorker, turnDetectorWorker, vad-web, onnxruntime-web,
// @huggingface/transformers) and every `new Worker(new URL(...))` call (App turn-detector worker).
const webStubs: Plugin = {
  name: 'sm-web-stubs',
  enforce: 'pre',
  resolveId(source) {
    if (/(^|\/)speechRecognition$/.test(source)) return stub('speechRecognition.ts')
    if (/(^|\/)(whisperWorker|turnDetectorWorker)(\.ts)?$/.test(source)) return stub('worker.ts')
    if (/^(@ricky0123\/vad-web|onnxruntime-web|@huggingface\/transformers)(\/|$)/.test(source)) return stub('worker.ts')
    if (/\.worker(\?worker)?$/.test(source) || /[?&]worker/.test(source)) return stub('worker.ts')
    return null
  },
  transform(code, id) {
    if (!/(\/src\/renderer\/.*\.tsx?|\/monaco-editor\/esm\/vs\/language\/json\/workerManager\.js)$/.test(id) || !code.includes('new Worker(')) return null
    return code.replace(/new Worker\(\s*new URL\([^)]*\)\s*,\s*\{[^}]*\}\s*,?\s*\)/g, 'new (class { constructor() { throw new Error("Not available in the web version") } })()')
  },
}

export default defineConfig({
  plugins: [webStubs, react()],
  root: path.resolve(__dirname, 'src/renderer/web'),
  publicDir: false,
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: path.resolve(__dirname, 'dist-web'),
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 20_000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: (a) => (a.name?.endsWith('.css') ? 'app.css' : '[name]-[hash][extname]'),
      },
    },
  },
})
