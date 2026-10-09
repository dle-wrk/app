import fs from 'node:fs';
import path from 'node:path';
import { test as setup, expect, type APIRequestContext } from '@playwright/test';
import { ADMIN, AUTH_FILE } from './env';

// Signs in once through the API and saves what the app keeps in the browser
// after a sign-in, so the other tests start signed in.
//
// The run starts only once the server reports ready (playwright.config.ts
// waits on /healthz), so one sign-in is enough: each attempt counts towards
// the sign-in rate limit.
async function signIn(request: APIRequestContext) {
  return request.post('/api/login', { data: { email: ADMIN.email, password: ADMIN.password } }).catch(() => null);
}

setup('sign in as the test admin', async ({ request, baseURL }) => {
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
