// One-time interactive DigiKey OAuth2 setup. Run with: npm run digikey:authorize
//
// This account's DigiKey app requires the 3-legged authorization-code flow (not
// client_credentials) — mirrors the flow proven to work in the reference script. Opens a
// browser for you to log into MyDigiKey and approve access, captures the redirect locally,
// exchanges the code for tokens, and saves DIGIKEY_REFRESH_TOKEN into .env. After this,
// the server refreshes access tokens on its own — no browser needed again unless DigiKey
// revokes the refresh token.
import fs from 'fs';
import path from 'path';
import http from 'http';
import { execSync } from 'child_process';
import dotenv from 'dotenv';

const envPath = path.resolve(process.cwd(), '.env');
dotenv.config({ path: envPath });

const CLIENT_ID = process.env.DIGIKEY_CLIENT_ID;
const CLIENT_SECRET = process.env.DIGIKEY_CLIENT_SECRET;
const REDIRECT_URI = process.env.DIGIKEY_REDIRECT_URI || 'http://localhost:8080/callback';
const AUTH_URL = 'https://api.digikey.com/v1/oauth2/authorize';
const TOKEN_URL = 'https://api.digikey.com/v1/oauth2/token';
const SCOPE = 'openid profile email';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('DIGIKEY_CLIENT_ID / DIGIKEY_CLIENT_SECRET are not set in .env. Add them first.');
  process.exit(1);
}

function persistEnvValue(key, value) {
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    // no .env yet
  }
  const line = `${key}="${value}"`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  content = pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}\n${line}\n`;
  fs.writeFileSync(envPath, content, 'utf8');
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') execSync(`start "" "${url}"`, { shell: 'cmd.exe' });
    else if (process.platform === 'darwin') execSync(`open "${url}"`);
    else execSync(`xdg-open "${url}"`);
  } catch {
    console.log(`Could not auto-open a browser. Visit this URL manually:\n${url}`);
  }
}

const redirectUrl = new URL(REDIRECT_URI);
const port = Number(redirectUrl.port || 80);
const callbackPath = redirectUrl.pathname;

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  if (reqUrl.pathname !== callbackPath) {
    res.writeHead(404).end();
    return;
  }
  const code = reqUrl.searchParams.get('code');
  const error = reqUrl.searchParams.get('error');

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(error
    ? `<html><body><h2>Authorization failed</h2><p>${error}</p><p>You may close this window.</p></body></html>`
    : `<html><body><h2>Authorization successful!</h2><p>You may close this window and return to the terminal.</p></body></html>`);

  server.close();

  if (error) {
    console.error(`DigiKey authorization was denied: ${error}`);
    process.exit(1);
  }
  if (!code) {
    console.error('No authorization code received.');
    process.exit(1);
  }
  exchangeCode(code);
});

server.listen(port, () => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state: 'digikey-authorize',
  });
  const authUrl = `${AUTH_URL}?${params.toString()}`;
  console.log('Opening browser for DigiKey authorization...');
  console.log(`Waiting for callback on ${REDIRECT_URI}`);
  openBrowser(authUrl);
});

async function exchangeCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    console.error(`Token exchange failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  if (!data.refresh_token) {
    console.error('DigiKey did not return a refresh_token. Response:', data);
    process.exit(1);
  }
  persistEnvValue('DIGIKEY_REFRESH_TOKEN', data.refresh_token);
  console.log('\n✅ DigiKey authorized. DIGIKEY_REFRESH_TOKEN saved to .env.');
  console.log('The server reads it once and moves it into the database — after that it refreshes');
  console.log('itself automatically and never touches .env again. If the dev server is running,');
  console.log('it will pick this up on its own restart (Vite watches .env).');
  process.exit(0);
}
