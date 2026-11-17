import { test, expect } from '@playwright/test';
import { ADMIN } from './env';

// The scanner phone app's side of the API, end to end on the throwaway
// database: sign in for a phone token, save a scan with a photo, read it
// back, and see it on the Pick Scans page. A phone sign-in must leave the
// web session alone (the other tests keep using it after this one).

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), Buffer.alloc(2048, 3), Buffer.from([0xff, 0xd9])]);

test.describe('scanner app', () => {
  test('signs in with a Tracklab account, saves a scan, and the web app shows it', async ({ page, request }) => {
    await page.goto('/');
    const webSession = await page.evaluate(() => localStorage.getItem('sessionId'));
    expect(webSession).toMatch(/^[a-f0-9]{48}$/);

    // Wrong password: refused, no token.
    const wrong = await request.post('/api/mobile/login', { data: { email: ADMIN.email, password: 'not-the-password' } });
    expect(wrong.status()).toBe(401);

    const login = await request.post('/api/mobile/login', { data: { email: ADMIN.email, password: ADMIN.password } });
    expect(login.status()).toBe(200);
    const { token, user } = await login.json();
    expect(token).toMatch(/^[a-f0-9]{48}$/);
    expect(user.email).toBe(ADMIN.email);
    const phone = { Authorization: `Bearer ${token}` };

    // The phone token works, and the web session was not signed out by it.
    expect((await request.get('/api/mobile/me', { headers: phone })).status()).toBe(200);
    expect((await request.get('/api/scans', { headers: { 'X-Session-Id': webSession! } })).status()).toBe(200);
    // A web session id is not accepted as a bearer token, and no token is a 401.
    expect((await request.get('/api/scans', { headers: { Authorization: `Bearer ${webSession}` } })).status()).toBe(401);
    expect((await request.get('/api/scans')).status()).toBe(401);

    const ref = `e2e-${Date.now()}`;
    const fields = { pickNote: `PICK-${ref}`, clientName: 'E2E Client', clientCode: 'E2E-1', description: 'Relay board', quantity: '3', clientRef: ref };
    const multipart = { ...fields, image: { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: JPEG } };
    const saved = await request.post('/api/scans', { headers: phone, multipart });
    expect(saved.status()).toBe(201);
    const scan = await saved.json();
    expect(scan).toMatchObject({ pickNote: fields.pickNote, description: 'Relay board', quantity: 3, clientName: 'E2E Client', clientOrder: null });
    expect(scan.user.email).toBe(ADMIN.email);

    // The phone retrying the same scan gets the saved one back, not a second copy.
    const resent = await request.post('/api/scans', { headers: phone, multipart });
    expect(resent.status()).toBe(200);
    expect((await resent.json()).id).toBe(scan.id);

    const list = await (await request.get(`/api/scans?pickNote=${fields.pickNote}`, { headers: phone })).json();
    expect(list.total).toBe(1);
    const photo = await request.get(scan.imageUrl, { headers: phone });
    expect(photo.headers()['content-type']).toBe('image/jpeg');
    expect((await photo.body()).length).toBe(JPEG.length);

    // On the web: Bookkeeping > Sales > Scanner > Pick scans lists it.
    await page.getByRole('button', { name: /^bookkeeping$/i }).first().click();
    await page.getByRole('button', { name: /^sales$/i }).first().click();
    await page.getByRole('button', { name: 'Scanner', exact: true }).click();
    await page.getByRole('button', { name: 'Pick scans', exact: true }).click();
    await expect(page.getByText(fields.pickNote)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Relay board')).toBeVisible();

    // Signing out on the phone ends the phone token only.
    expect((await request.post('/api/session/logout', { headers: phone, data: {} })).status()).toBe(200);
    expect((await request.get('/api/mobile/me', { headers: phone })).status()).toBe(401);
    expect((await request.get('/api/scans', { headers: { 'X-Session-Id': webSession! } })).status()).toBe(200);
  });

  test('books a reel in and out by its label, and the web app shows the booking and the new stock', async ({ page, request }) => {
    await page.goto('/');
    const web = { 'X-Session-Id': (await page.evaluate(() => localStorage.getItem('sessionId')))! };
    const code = `E2E-REEL-${Date.now()}`;
    const mpn = `E2EMPN${Date.now()}`;
    const made = await request.post('/api/items', { headers: web, data: { serial_number: code, name: 'E2E reel', stock: 100, man_pn_1: mpn, packaging: 'reel' } });
    expect(made.status()).toBe(201);
    const place = await request.post('/api/stock-locations', { headers: web, data: { code: `E2E-${Date.now()}`, name: 'E2E rack' } });
    expect(place.ok()).toBeTruthy();
    const locationId = (await place.json()).id;

    const { token } = await (await request.post('/api/mobile/login', { data: { email: ADMIN.email, password: ADMIN.password } })).json();
    const phone = { Authorization: `Bearer ${token}` };

    // The 2D code on a supplier reel label: maker part, quantity, lot, date code.
    const GS = '\x1d';
    const label = `[)>\x1e06${GS}PSUP-123-ND${GS}1P${mpn}${GS}Q4000${GS}1TLOT42${GS}9D2535`;
    const found = await (await request.get(`/api/stock-moves/find?code=${encodeURIComponent(label)}`, { headers: phone })).json();
    expect(found).toMatchObject({ exact: true, matchedBy: 'part number', label: { quantity: 4000, lot: 'LOT42', dateCode: '2535' } });
    expect(found.items[0]).toMatchObject({ partNumber: code, stock: 100 });

    const ref = `e2e-move-${Date.now()}`;
    const booking = { direction: 'IN', partNumber: code, quantity: 4000, locationId, lot: 'LOT42', dateCode: '2535', reference: 'PO-E2E', clientRef: ref };
    const inRes = await request.post('/api/stock-moves', { headers: phone, data: booking });
    expect(inRes.status()).toBe(201);
    expect(await inRes.json()).toMatchObject({ direction: 'IN', quantity: 4000, stockAfter: 4100 });
    // The phone retrying the same booking does not book twice.
    const again = await request.post('/api/stock-moves', { headers: phone, data: booking });
    expect(again.status()).toBe(200);
    expect(await again.json()).toMatchObject({ alreadySaved: true, stockAfter: 4100 });

    const out = await request.post('/api/stock-moves', { headers: phone, data: { direction: 'OUT', partNumber: code, quantity: 150, locationId, note: 'line 2' } });
    expect(out.status()).toBe(201);
    expect(await out.json()).toMatchObject({ direction: 'OUT', stockAfter: 3950 });
    const tooMany = await request.post('/api/stock-moves', { headers: phone, data: { direction: 'OUT', partNumber: code, quantity: 99999 } });
    expect(tooMany.status()).toBe(409);

    const after = await (await request.get(`/api/stock-moves/find?code=${code}`, { headers: phone })).json();
    expect(after.items[0]).toMatchObject({ stock: 3950, noLocation: 100 });
    expect(after.items[0].places[0]).toMatchObject({ locationId, quantity: 3850 });

    // On the web: Bookkeeping > Sales > Scanner lists both bookings.
    await page.getByRole('button', { name: /^bookkeeping$/i }).first().click();
    await page.getByRole('button', { name: /^sales$/i }).first().click();
    await page.getByRole('button', { name: 'Scanner', exact: true }).click();
    await page.getByRole('button', { name: 'Stock in & out', exact: true }).click();
    await expect(page.getByText(code).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('+4000')).toBeVisible();
    await expect(page.getByText('−150')).toBeVisible();

    await request.post('/api/session/logout', { headers: phone, data: {} });
  });
});
