import { test, expect } from '@playwright/test';

test('verify app navigation and rendering', async ({ page }) => {
  await page.goto('http://127.0.0.1:3000');
  await page.waitForTimeout(3000);

  // Verify Dashboard
  await expect(page.locator('h3')).toContainText('Inventory Insights');
  await page.screenshot({ path: '/home/jules/verification/screenshots/dashboard_v2.png' });

  // Navigate to Items
  await page.click('button:has-text("Items & Inventory")');
  await page.waitForTimeout(1000);
  await expect(page.locator('h3')).toContainText('Inventory items');
  await page.screenshot({ path: '/home/jules/verification/screenshots/inventory_v2.png' });
});
