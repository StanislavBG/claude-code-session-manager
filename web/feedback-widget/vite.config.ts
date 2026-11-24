import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { FONT_FACES, FONTS_DIR } from './src/ui/tokens';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// Self-hosted fonts (DESIGN_SPEC.md "Decided changes" 2): the latin woff2 files of every
// face loadFonts() declares are emitted to dist/fonts/, next to feedback.js.
function copyFonts(): Plugin {
  return {
    name: 'feedback-widget-copy-fonts',
    apply: 'build',
    generateBundle() {
      for (const f of FONT_FACES) {
        const file = new URL(`./node_modules/${f.pkg}/files/${f.file}`, import.meta.url);
        this.emitFile({ type: 'asset', fileName: `${FONTS_DIR}${f.file}`, source: readFileSync(file) });
      }
    },
  };
}

// One self-contained IIFE (dist/feedback.js) that a customer site loads with a single
// <script> tag — no other JS chunk, so dynamic imports are inlined.
export default defineConfig({
  plugins: [copyFonts()],
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
