import { test, expect } from '@playwright/test';
import { openSignedIn } from './env';

test('verify app navigation and rendering', async ({ page }) => {
  await openSignedIn(page);

  // Verify Dashboard
  await expect(page.getByRole('heading', { name: 'Inventory Insights' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('dashboard_v2.png') });

  // Navigate to Items (in the STOCK section, closed at first)
  await page.click('button:has-text("STOCK")');
  await page.click('button:has-text("Items & Inventory")');
  await page.waitForTimeout(1000);
  await expect(page.getByRole('heading', { name: 'Inventory items' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('inventory_v2.png') });
});
