import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './src/__tests__',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 13'] },
    },
  ],
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
