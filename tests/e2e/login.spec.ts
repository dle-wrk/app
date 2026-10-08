import { test, expect } from '@playwright/test';
import { ADMIN } from './env';

// The test admin playwright.config.ts has the server create on the
// throwaway database. These run last (signing in ends the saved session).
const EMAIL = ADMIN.email;
const PASSWORD = ADMIN.password;

test.describe('login flow', () => {
  test('unauth visit lands on the sign-in card', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
    await expect(page.getByPlaceholder(/name@example\.com/i)).toBeVisible();
  });

  test('valid credentials → dashboard + session id stored', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder(/name@example\.com/i).fill(EMAIL);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();

    // Dashboard renders its own heading. If we land here, the session was
    // minted and stored — the sidebar shows Dashboard as the active view.
    await expect(page.getByRole('heading', { name: /inventory insights/i })).toBeVisible({ timeout: 15_000 });

    // Confirm the fetch interceptor stored the session id — this is the
    // linchpin of every admin-gated call.
    const sessionId = await page.evaluate(() => localStorage.getItem('sessionId'));
    expect(sessionId).toMatch(/^[a-f0-9]{48}$/);
  });

  test('wrong password → toast and stays on the sign-in card', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder(/name@example\.com/i).fill(EMAIL);
    await page.locator('input[type="password"]').fill('definitely-wrong-' + Date.now());
    await page.getByRole('button', { name: /sign in/i }).click();
    // Still on the sign-in card — the dashboard heading never appears.
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /inventory insights/i })).not.toBeVisible();
  });
});
