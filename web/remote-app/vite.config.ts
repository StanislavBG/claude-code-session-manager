import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served as a static-path sibling at bilko.run/projects/session-manager/ — all
// asset URLs must be prefixed with that base (host-contract.md §static-path).
export default defineConfig({
  base: '/projects/session-manager/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    // Playwright specs live in tests/ and run via `npm run test:e2e`, not vitest.
    include: ['src/**/*.spec.{ts,tsx}'],
  },
});
