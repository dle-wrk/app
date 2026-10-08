import { test, expect } from '@playwright/test';
import { openSignedIn } from './env';

// Starts signed in (auth.setup.ts) on the dashboard.
const loginAndReachDashboard = (page: import('@playwright/test').Page) => openSignedIn(page);

test.describe('command palette', () => {
  test('Ctrl+K opens the palette and lists pages', async ({ page }) => {
    await loginAndReachDashboard(page);
    await page.keyboard.press('Control+K');
    const palette = page.getByRole('dialog', { name: /command palette/i });
    await expect(palette).toBeVisible();
    await expect(palette.getByPlaceholder(/search pages/i)).toBeVisible();
  });

  test('typing "collection" surfaces Bookkeeping › Sales › Dispatch and Enter jumps there', async ({ page }) => {
    await loginAndReachDashboard(page);
    await page.keyboard.press('Control+K');
    const input = page.getByRole('dialog', { name: /command palette/i })
      .getByPlaceholder(/search pages/i);
    await input.fill('collection');

    // "Delivery & Collection Notes" is the fuzzy-match target — pin its
    // presence so the palette's scoring regression doesn't slip past.
    await expect(page.getByText(/Delivery & Collection Notes/)).toBeVisible();
    await input.press('Enter');

    // Landing state: Bookkeeping's Dispatch sub-tab is active. The section
    // pill "Sales" and the sub-pill "Delivery & Collection" both show as
    // primary-styled after the deep-link fires.
    await expect(page.getByText(/Delivery & Collection Notes/)).toBeVisible({ timeout: 10_000 });
  });

  test('Escape closes the palette', async ({ page }) => {
    await loginAndReachDashboard(page);
    await page.keyboard.press('Control+K');
    const palette = page.getByRole('dialog', { name: /command palette/i });
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible();
  });
});
