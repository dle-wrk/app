import { test, expect } from '@playwright/test';

test('verify production kits management', async ({ page }) => {
  await page.goto('http://127.0.0.1:3000');
  await page.waitForTimeout(3000);

  // Navigate to Stock Tables
  await page.click('button:has-text("Stock Tables")');
  await page.waitForTimeout(1000);

  // Verify StockTablesView is rendered
  await expect(page.locator('text=VIEWING TABLE: PRODUCTION_KITS')).toBeVisible();

  // Click "Provision New Kit"
  await page.click('button:has-text("Provision New Kit")');
  await page.waitForTimeout(1000);

  // Fill in the form
  await page.fill('input[placeholder="e.g. KIT-MGD-048"]', 'KIT-VERIFY-1');
  await page.fill('input[placeholder="e.g. TL-MCU-ESP32-V2"]', 'SKU-VERIFY-1');
  await page.fill('input[placeholder="e.g. Line 4 Delta Matrix"]', 'Line Alpha');
  await page.fill('input[type="number"]', '50');

  // Select a project (if available)
  const projectSelect = page.locator('select[aria-label="Project Selection"]');
  await projectSelect.selectOption({ index: 1 });

  await page.screenshot({ path: 'screenshots/kit_creation_form.png' });

  // Instantiate Kit
  await page.click('button:has-text("Instantiate Production Kit")');
  await page.waitForTimeout(2000);

  // Verify kit is in the table
  await expect(page.locator('table').locator('text=KIT-VERIFY-1')).toBeVisible();
  await page.screenshot({ path: 'screenshots/kits_table_updated.png' });

  // Click Edit button for the new kit
  const row = page.locator('tr', { hasText: 'KIT-VERIFY-1' }).first();
  await row.locator('button[title="Edit Kit"]').click();
  await page.waitForTimeout(1000);

  // Verify form is pre-populated
  await expect(page.locator('input[value="KIT-VERIFY-1"]')).toBeVisible();
  await expect(page.locator('button:has-text("Update Production Kit")')).toBeVisible();

  // Change something and update
  await page.fill('input[placeholder="e.g. Line 4 Delta Matrix"]', 'Line Beta');
  await page.click('button:has-text("Update Production Kit")');
  await page.waitForTimeout(2000);

  // Verify update
  await expect(page.locator('text=Line Beta')).toBeVisible();
  await page.screenshot({ path: 'screenshots/kits_table_after_edit.png' });
});
