import { defineConfig, devices } from '@playwright/test';

// Playwright config for the E2E smoke suite. Vitest owns the unit tests via
// its own `test.include` in vite.config.ts; Playwright's include here is
// scoped to `tests/e2e/` so the two runners don't collide.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Skip HTTPS cert checks in local; prod is trusted anyway.
    ignoreHTTPSErrors: true,
  },
  // Boot the app for CI runs. Locally you can point PLAYWRIGHT_BASE_URL at
  // an already-running dev server and skip this altogether.
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
