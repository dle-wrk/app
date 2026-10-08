
import { test as base, expect } from '@playwright/test';
import { sessionHeaders } from './env';

// Every API call needs a session: the saved one (auth.setup.ts), read when a
// test starts (the file doesn't exist yet when the tests are listed).
const test = base.extend({
  extraHTTPHeaders: async ({}, use) => { await use(sessionHeaders()); },
});

test.describe('API Optimization and Validation Tests', () => {
  const API_URL = '/api';

  test('GET /api/items should support pagination', async ({ request }) => {
    const response = await request.get(`${API_URL}/items?limit=5&offset=0`, {
      headers: { 'x-request-format': 'paginated' }
    });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.data).toBeDefined();
    expect(body.data.length).toBeLessThanOrEqual(5);
    expect(body.pagination).toBeDefined();
    expect(body.pagination.total).toBeGreaterThan(0);
  });

  test('GET /api/items should remain backward compatible', async ({ request }) => {
    const response = await request.get(`${API_URL}/items`);
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(Array.isArray(body)).toBeTruthy();
  });

  test('POST /api/items should validate input using Zod', async ({ request }) => {
    const response = await request.post(`${API_URL}/items`, {
      data: {
        // Missing serial_number which is required
        name: 'Test Item'
      }
    });
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid item data');
  });

  test('PATCH /api/items/:id should update partially', async ({ request }) => {
    // First, let's get an existing item
    const itemsRes = await request.get(`${API_URL}/items?limit=1`);
    const items = await itemsRes.json();
    const item = items.data[0];
    const originalName = item.name;

    const patchRes = await request.patch(`${API_URL}/items/${encodeURIComponent(item.serial_number)}`, {
      data: {
        name: originalName + ' (Updated)'
      }
    });
    expect(patchRes.ok()).toBeTruthy();
    const updatedItem = await patchRes.json();
    expect(updatedItem.name).toBe(originalName + ' (Updated)');

    // Revert change
    await request.patch(`${API_URL}/items/${encodeURIComponent(item.serial_number)}`, {
      data: {
        name: originalName
      }
    });
  });

  test('POST /api/items/bulk should validate input', async ({ request }) => {
    const response = await request.post(`${API_URL}/items/bulk`, {
      data: [
        { serial_number: 'BULK-TEST-1', name: 'Bulk Item 1', stock: 10 },
        { name: 'Invalid Bulk Item' } // Missing serial_number
      ]
    });
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid items array');
  });
});
