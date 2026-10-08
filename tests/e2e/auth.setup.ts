import fs from 'node:fs';
import path from 'node:path';
import { test as setup, expect } from '@playwright/test';
import { ADMIN, AUTH_FILE } from './env';

// Signs in once through the API and saves what the app keeps in the browser
// after a sign-in, so the other tests start signed in.
setup('sign in as the test admin', async ({ request, baseURL }) => {
  const res = await request.post('/api/login', { data: { email: ADMIN.email, password: ADMIN.password } });
  expect(res.ok(), `sign-in failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const user = await res.json();
  expect(user.sessionId).toMatch(/^[a-f0-9]{48}$/);
  expect(user.mustChangePassword).toBe(false);

  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify({
    cookies: [],
    origins: [{
      origin: new URL(baseURL!).origin,
      localStorage: [
        { name: 'userLoggedIn', value: 'true' },
        { name: 'currentUser', value: JSON.stringify(user) },
        { name: 'sessionId', value: user.sessionId },
      ],
    }],
  }, null, 2));
});
