import fs from 'node:fs';
import path from 'node:path';
import { test as setup, expect, type APIRequestContext } from '@playwright/test';
import { ADMIN, AUTH_FILE } from './env';

// Signs in once through the API and saves what the app keeps in the browser
// after a sign-in, so the other tests start signed in.
//
// On an empty database the server takes a while to create its tables after
// the page server is already answering, and sign-in says "database
// unavailable" (503) until then, so keep trying for a few minutes.
async function signIn(request: APIRequestContext) {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const res = await request.post('/api/login', { data: { email: ADMIN.email, password: ADMIN.password } }).catch(() => null);
    const retryable = !res || res.status() === 503 || res.status() === 502 || res.status() === 504;
    if (!retryable || Date.now() > deadline) return res;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

setup('sign in as the test admin', async ({ request, baseURL }) => {
  setup.setTimeout(240_000);
  const res = await signIn(request);
  expect(res, 'the server never answered').toBeTruthy();
  expect(res!.ok(), `sign-in failed: ${res!.status()} ${await res!.text()}`).toBeTruthy();
  const user = await res!.json();
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
