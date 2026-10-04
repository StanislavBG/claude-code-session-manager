import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'))

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // A manualChunks *array* entry (the previous `{ 'monaco-editor': ['monaco-editor'] }`)
        // resolves 'monaco-editor' to its full package entry and force-includes it — and
        // everything it statically imports (every basic language + the ts/css/html workers) —
        // as its own rollup entry point, regardless of what the app actually imports from it.
        // A function instead only groups modules rollup *already* reached via the real import
        // graph, so lib/monaco.ts's per-language imports actually control what ships.
        manualChunks(id) {
          if (id.includes('/node_modules/monaco-editor/')) return 'monaco-editor'
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
