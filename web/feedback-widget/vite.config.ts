import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// One self-contained IIFE (dist/feedback.js) that a customer site loads with a single
// <script> tag — no other JS chunk, so dynamic imports are inlined.
export default defineConfig({
  define: {
    __WIDGET_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: 'src/index.ts',
      formats: ['iife'],
      name: 'SmFeedback',
      fileName: () => 'feedback.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  test: {
    environment: 'jsdom',
    // Playwright specs (npm run e2e) live outside src/ and never run under vitest.
    include: ['src/**/*.{spec,test}.{ts,tsx}'],
  },
});
