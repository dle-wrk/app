import fs from 'node:fs';
import { expect, type Page } from '@playwright/test';

// What the E2E tests share: the test admin (playwright.config.ts sets it and
// has the server create it on the throwaway database) and the saved session
// from auth.setup.ts.

export const AUTH_FILE = 'playwright/.auth/admin.json';

export const ADMIN = {
  get email() { return process.env.TEST_ADMIN_EMAIL ?? ''; },
  get password() { return process.env.TEST_ADMIN_PASSWORD ?? ''; },
};

/** The saved session's X-Session-Id header, for API calls. */
export function sessionHeaders(): Record<string, string> {
  const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  const sessionId = state.origins?.[0]?.localStorage?.find((e: { name: string }) => e.name === 'sessionId')?.value;
  if (!sessionId) throw new Error(`No session in ${AUTH_FILE}; the setup project signs in first.`);
  return { 'X-Session-Id': sessionId };
}

/** Opens the app with the saved session and waits for the dashboard. */
export async function openSignedIn(page: Page, path = '/') {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: /inventory insights/i })).toBeVisible({ timeout: 20_000 });
}
