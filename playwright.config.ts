import fs from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { AUTH_FILE } from './tests/e2e/env';

// Playwright config for the E2E smoke suite. Vitest owns the unit tests via
// its own `test.include` in vite.config.ts; Playwright's include here is
// scoped to `tests/e2e/` so the two runners don't collide.
//
// The suite creates projects, kits and BOM lines and edits items, so it runs
// against a throwaway database, never the real one:
//   - E2E_DATABASE_URL names it (CI starts an empty Postgres for each run).
//     The app's server is started on it, creates its tables, adds a few
//     sample items and projects, and an admin account (TEST_ADMIN_EMAIL /
//     TEST_ADMIN_PASSWORD) that the tests sign in with.
//   - It refuses to start when E2E_DATABASE_URL is missing, or is the
//     database in .env (the production one), and refuses to point at the
//     live site.
// Locally: E2E_DATABASE_URL=postgres://… npm run test:e2e

const LIVE_HOSTS = ['tracklab-im.fly.dev'];

/** host + database name, so the same database given two ways still matches (Neon's -pooler host too). */
function databaseKey(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.hostname.replace('-pooler.', '.').toLowerCase()}${u.pathname.toLowerCase()}`;
  } catch {
    return null;
  }
}

function dotenvDatabaseUrl(): string | undefined {
  try {
    return fs.readFileSync('.env', 'utf8').match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m)?.[1];
  } catch {
    return undefined;
  }
}

const baseURLOverride = process.env.PLAYWRIGHT_BASE_URL;
if (baseURLOverride && LIVE_HOSTS.some((h) => baseURLOverride.includes(h))) {
  throw new Error('PLAYWRIGHT_BASE_URL points at the live site. The E2E tests change data; run them against a test server.');
}

const e2eDatabase = process.env.E2E_DATABASE_URL;
if (!baseURLOverride) {
  if (!e2eDatabase) {
    throw new Error('Set E2E_DATABASE_URL to a throwaway Postgres database. The E2E tests create and change data, so they never run on the database in .env.');
  }
  const prod = [dotenvDatabaseUrl(), process.env.DATABASE_URL].map(databaseKey).filter(Boolean);
  if (prod.includes(databaseKey(e2eDatabase))) {
    throw new Error('E2E_DATABASE_URL is the same database as DATABASE_URL (production). Use a throwaway database.');
  }
}

// The admin the server creates on the empty database, and the tests sign in as.
process.env.TEST_ADMIN_EMAIL ||= 'e2e-admin@tracklab.test';
process.env.TEST_ADMIN_PASSWORD ||= 'e2e-only-password-1';

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
    baseURL: baseURLOverride || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Skip HTTPS cert checks in local; prod is trusted anyway.
    ignoreHTTPSErrors: true,
  },
  // Boot the app on the throwaway database. Never reuse a server that is
  // already running: a dev server started the usual way is on production.
  webServer: baseURLOverride ? undefined : {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: false,
    timeout: 180_000,
    // The server's own output, so CI can show why it failed (see ci.yml).
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...(process.env as Record<string, string>),
      DATABASE_URL: e2eDatabase!,
      SEED_ADMIN_EMAIL: process.env.TEST_ADMIN_EMAIL,
      SEED_ADMIN_PASSWORD: process.env.TEST_ADMIN_PASSWORD,
      BULK_PRICING_AUTO: 'off',
    },
  },
  projects: [
    // Signs in once and saves the session for the other tests (each sign-in
    // ends the account's other sessions, and sign-ins are rate limited).
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: AUTH_FILE },
      dependencies: ['setup'],
      testIgnore: [/login\.spec\.ts/, /auth\.setup\.ts/],
    },
    // Last: signing in here ends the saved session the others use.
    {
      name: 'sign-in',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['chromium'],
      testMatch: /login\.spec\.ts/,
    },
  ],
});
