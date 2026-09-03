
import { test, expect } from '@playwright/test';

test('verify enhanced BOM management in ProjectsView', async ({ page }) => {
  test.setTimeout(60000);
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.error('PAGE ERROR:', err.message));

  page.on('request', req => {
    if (req.url().includes('/api/')) {
      console.log(`[PLAYWRIGHT REQ] ${req.method()} ${req.url()}`);
    }
  });
  page.on('requestfinished', req => {
    if (req.url().includes('/api/')) {
      console.log(`[PLAYWRIGHT FINISHED] ${req.method()} ${req.url()}`);
    }
  });
  page.on('requestfailed', req => {
    if (req.url().includes('/api/')) {
      console.log(`[PLAYWRIGHT FAILED] ${req.method()} ${req.url()} Error: ${req.failure()?.errorText}`);
    }
  });

  page.on('response', response => {
    if (response.status() >= 400) {
      console.log(`PAGE NETWORK ERROR: ${response.request().method()} ${response.url()} -> ${response.status()}`);
    }
  });
  await page.goto('http://127.0.0.1:3000/?test=true&v=' + Date.now());

  // Wait for initial load
  await page.waitForSelector('span:has-text("Project Manager")');

  // Navigate to Project Manager via Sidebar
  await page.click('span:has-text("Project Manager")');

  // Create a new project to have a clean state
  await page.click('button:has-text("New Project")');
  const projectName = `Test Project ${Date.now()}`;
  await page.fill('input#projectName', projectName);
  await page.click('button[type="submit"]:has-text("Create Project")');

  // Find the newly created project card
  const projectCard = page.locator('div.bg-surface-container').filter({ has: page.locator(`span:has-text("${projectName}")`) });
  await projectCard.locator('button:has-text("Link Components")').click();

  // Verify BOM Manager modal is open
  const modal = page.locator('div.fixed.inset-0.bg-background\\/80');
  await expect(modal.locator('h4:has-text("BOM Manager")')).toBeVisible({ timeout: 15000 });

  // Search for a component in the LEFT column
  const leftCol = modal.locator('div.flex.flex-col.h-full.overflow-hidden.border-r');
  await leftCol.locator('input[placeholder="Search stock code or name..."]').fill('ANT-001');

  // Click to add (from left column)
  await leftCol.locator('span:has-text("ANT-001")').click();

  // Verify it's in the Current BOM (Right Column)
  const rightCol = modal.locator('div.flex.flex-col.h-full.overflow-hidden').nth(1);
  const bomItemContainer = rightCol.locator('div.bg-surface-container-high\\/50').filter({ hasText: 'ANT-001' });
  await expect(bomItemContainer).toBeVisible();

  // Edit quantity
  const qtyInput = bomItemContainer.locator('input[type="number"]');
  await qtyInput.fill('5');

  // Edit designator
  const desInput = bomItemContainer.locator('input[placeholder="e.g. C1, C2, R15"]');
  await desInput.fill('A1, A2');

  // Edit comment
  const commentInput = bomItemContainer.locator('input[placeholder="Additional notes for this line item..."]');
  await commentInput.fill('Test Comment');

  // Sync
  await page.screenshot({ path: test.info().outputPath('before_sync.png') });

  // Click the Sync button natively
  await modal.locator('button:has-text("Sync")').click();

  await page.waitForTimeout(2000);
  await page.screenshot({ path: test.info().outputPath('after_sync.png') });

  // Verify toast
  await expect(page.locator('text=linked to project')).toBeVisible();

  // Re-open and verify persistence
  await projectCard.locator('button:has-text("Link Components")').click();
  const bomItemReloaded = modal.locator('div.bg-surface-container-high\\/50').filter({ hasText: 'ANT-001' });
  await expect(bomItemReloaded.locator('input[type="number"]')).toHaveValue('5');
  await expect(bomItemReloaded.locator('input[placeholder="e.g. C1, C2, R15"]')).toHaveValue('A1, A2');
  await expect(bomItemReloaded.locator('input[placeholder="Additional notes for this line item..."]')).toHaveValue('Test Comment');
});
