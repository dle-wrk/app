// Pricing surface extracted from server.ts. Owns everything under
// /api/pricing/* plus /api/suppliers/compare-prices (which finally moves here
// alongside the provider clients it uses). Covers:
//   - live-price lookups against DigiKey, Mouser, LCSC (scrape + live),
//     Nexar (Octopart aggregator), element14/Farnell, and TME
//   - a per-provider daily counter (pricing_api_usage) with a shared cap
//   - the pricing_cache table (single-part) and lcsc_price_cache (scrape feed)
//   - the DigiKey OAuth2 token dance (client_credentials preferred, refresh
//     token as fallback, stored encrypted so a Vite dev restart can't wipe it)
//   - encrypted API-key storage in pricing_api_keys, managed from the UI via
//     admin-gated /api/pricing/keys endpoints
//   - a bulk refresh that walks the inventory table and writes bulk_price_zar
//     using the exchange-rate map from ./exchangeRate
//
// Dependencies deliberately kept narrow: db + serverUtils for the crypto
// primitives, authRoutes only for the admin gate on key management, and
// exchangeRate for the FX conversion in bulk-refresh.

import type { Express } from 'express';
import { z } from 'zod';
import { createHmac } from 'node:crypto';
import { query, queryOne } from './db';
import {
  deriveCredKey,
  encryptCreds as _encryptCreds,
  decryptCreds as _decryptCreds,
  isCipherEnvelope,
  type CipherEnvelope,
} from './serverUtils';
import { requireAdmin } from './authRoutes';
import { readExchangeRate } from './exchangeRate';

// ---------------------------------------------------------------------------
// At-rest encryption for provider API keys. AES-256-GCM keyed on PRICING_CRED_KEY.
// On Fly, set it via `flyctl secrets set PRICING_CRED_KEY=...`. The fallback
// derives from DATABASE_URL — not great, but at least the key isn't in the
// same table as the ciphertexts.
// ---------------------------------------------------------------------------
const CRED_KEY_MATERIAL = process.env.PRICING_CRED_KEY || `fallback:${process.env.DATABASE_URL || 'dev'}`;
const CRED_KEY = deriveCredKey(CRED_KEY_MATERIAL);
const encryptCreds = (creds: Record<string, string>): CipherEnvelope => _encryptCreds(creds, CRED_KEY);
const decryptCreds = (env: CipherEnvelope): Record<string, string> => _decryptCreds(env, CRED_KEY);

// --- Live pricing lookups (DigiKey, Mouser APIs; LCSC via externally-fed scrape cache) ---
const PRICING_DAILY_LIMIT = 1000;

async function getPricingUsage(provider: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const row = await queryOne<{ count: number }>(
    `SELECT count FROM pricing_api_usage WHERE provider = $1 AND usage_date = $2`,
    [provider, today]
  );
  return row?.count ?? 0;
}

async function incrementPricingUsage(provider: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const row = await queryOne<{ count: number }>(
    `INSERT INTO pricing_api_usage (provider, usage_date, count) VALUES ($1, $2, 1)
     ON CONFLICT (provider, usage_date) DO UPDATE SET count = pricing_api_usage.count + 1
     RETURNING count`,
    [provider, today]
  );
  return row!.count;
}

// ---------------------------------------------------------------------------
// Provider configuration & DB-backed API key management
//
// Keys live in `pricing_api_keys` so the UI can manage them. Reads fall back
// to process.env for backwards compatibility — existing deployments keep
// working without migrating, and the UI can override .env values at any time.
// ---------------------------------------------------------------------------

interface PricingFieldConfig {
  name: string;
  label: string;
  envVar: string;
  type: 'text' | 'password';
  required?: boolean;
  help?: string;
}

interface PricingProviderConfig {
  provider: string;
  label: string;
  description: string;
  fields: PricingFieldConfig[];
}

const PRICING_PROVIDERS: PricingProviderConfig[] = [
  {
    provider: 'digikey',
    label: 'DigiKey',
    description: 'OAuth2 client_credentials (falls back to 3-legged refresh token).',
    fields: [
      { name: 'client_id', label: 'Client ID', envVar: 'DIGIKEY_CLIENT_ID', type: 'text', required: true },
      { name: 'client_secret', label: 'Client Secret', envVar: 'DIGIKEY_CLIENT_SECRET', type: 'password', required: true },
      { name: 'redirect_uri', label: 'Redirect URI', envVar: 'DIGIKEY_REDIRECT_URI', type: 'text' },
      { name: 'refresh_token', label: 'Refresh Token', envVar: 'DIGIKEY_REFRESH_TOKEN', type: 'password', help: 'Only needed for 3-legged OAuth. Run "npm run digikey:authorize" to mint one.' },
      { name: 'locale_site', label: 'Locale Site', envVar: 'DIGIKEY_LOCALE_SITE', type: 'text' },
      { name: 'locale_language', label: 'Locale Language', envVar: 'DIGIKEY_LOCALE_LANGUAGE', type: 'text' },
      { name: 'locale_currency', label: 'Locale Currency', envVar: 'DIGIKEY_LOCALE_CURRENCY', type: 'text' },
      { name: 'locale_ship_to_country', label: 'Ship-to Country', envVar: 'DIGIKEY_LOCALE_SHIP_TO_COUNTRY', type: 'text' },
    ],
  },
  {
    provider: 'mouser',
    label: 'Mouser',
    description: 'Simple API key authentication.',
    fields: [
      { name: 'api_key', label: 'API Key', envVar: 'MOUSER_API_KEY', type: 'password', required: true },
    ],
  },
  {
    provider: 'lcsc',
    label: 'LCSC',
    description: 'Live lookup needs no key. Import token protects the bulk-import endpoint.',
    fields: [
      { name: 'import_token', label: 'Import Token', envVar: 'LCSC_IMPORT_TOKEN', type: 'password' },
    ],
  },
  {
    provider: 'nexar',
    label: 'Nexar (Octopart)',
    description: 'Aggregator covering Arrow, Heilind, Avnet, TME, RS Components, and more.',
    fields: [
      { name: 'api_key', label: 'API Key (Client ID)', envVar: 'NEXAR_API_KEY', type: 'text', required: true },
      { name: 'api_secret', label: 'API Secret', envVar: 'NEXAR_API_SECRET', type: 'password', required: true },
    ],
  },
  {
    provider: 'element14',
    label: 'Element14 / Farnell',
    description: 'Free API key from https://partner.element14.com/',
    fields: [
      { name: 'api_key', label: 'API Key', envVar: 'ELEMENT14_API_KEY', type: 'password', required: true },
      { name: 'store_id', label: 'Store ID', envVar: 'ELEMENT14_STORE_ID', type: 'text', help: 'Full store domain, e.g. uk.farnell.com (default), us.newark.com, de.farnell.com. There is no ZA store — South Africa uses the UK catalogue, priced in GBP.' },
    ],
  },
  {
    provider: 'tme',
    label: 'TME',
    description: 'HMAC-SHA1 signed requests. Get credentials at https://developers.tme.eu/',
    fields: [
      { name: 'api_key', label: 'Private Key', envVar: 'TME_API_KEY', type: 'text', required: true, help: 'The generated Private Key from your Tracklab ERP app on developers.tme.eu. Same key works for anonymous market data — this app sends request-context: anonymous so no customer-specific pricing is used. To obtain: log into tme.eu customer account → User Panel → Applications → Register new app → copy the Temporary Token → paste it back on developers.tme.eu → Generate new private key → Show private keys.' },
      { name: 'api_secret', label: 'Application Secret', envVar: 'TME_API_SECRET', type: 'password', required: true, help: 'The Application secret shown at the top of your app card on developers.tme.eu (reveal with the eye icon).' },
    ],
  },
];

// In-memory cache of DB-stored credentials, keyed by provider. Invalidated on
// write so a key saved from the UI is visible immediately without a restart.
const pricingKeyCache = new Map<string, Record<string, string>>();

function invalidatePricingKeyCache(provider?: string): void {
  if (provider) {
    pricingKeyCache.delete(provider);
  } else {
    pricingKeyCache.clear();
  }
}

async function loadProviderCredentials(provider: string): Promise<Record<string, string>> {
  if (pricingKeyCache.has(provider)) return pricingKeyCache.get(provider)!;
  const row = await queryOne<{ credentials: any }>(
    `SELECT credentials FROM pricing_api_keys WHERE provider = $1`,
    [provider]
  );
  let creds: Record<string, string> = {};
  const stored = row?.credentials;
  if (stored) {
    if (isCipherEnvelope(stored)) {
      try { creds = decryptCreds(stored); }
      catch (err: any) { console.error(`[creds] failed to decrypt ${provider}:`, err.message); }
    } else if (typeof stored === 'object') {
      // Legacy plaintext row — accept it now, will re-encrypt on next write.
      creds = stored;
    }
  }
  pricingKeyCache.set(provider, creds);
  return creds;
}

// Read a single credential: DB first, then process.env fallback.
async function getPricingCredential(provider: string, field: string, envVar: string): Promise<string | undefined> {
  const dbCreds = await loadProviderCredentials(provider);
  const val = dbCreds[field] || process.env[envVar];
  return val || undefined;
}

async function isProviderConfigured(provider: string): Promise<boolean> {
  const config = PRICING_PROVIDERS.find(p => p.provider === provider);
  if (!config) return false;
  for (const field of config.fields) {
    if (field.required) {
      const val = await getPricingCredential(provider, field.name, field.envVar);
      if (!val) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// DigiKey OAuth. Product Information API v4 requires 3-legged OAuth2 for this
// account (not client_credentials) — confirmed against the working reference
// script. Run `npm run digikey:authorize` once to mint a refresh token; after
// that, access tokens are silently refreshed server-side. The refresh token
// is rotated by DigiKey on every use, so it's stored in `pricing_tokens` —
// rewriting .env under `vite dev` would trigger a dev-server restart, killing
// the very in-flight request that just rotated the token.
// ---------------------------------------------------------------------------
let digikeyAccessToken: { token: string; expiresAt: number } | null = null;
let cachedDigikeyRefreshToken: string | null = null;

// Stored value is either raw plaintext (legacy) or a JSON-serialised
// CipherEnvelope. Detect at read time; write as ciphertext going forward.
function unwrapStoredToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (isCipherEnvelope(parsed)) {
      const decrypted = decryptCreds({ ...parsed, ct: parsed.ct });
      return decrypted.token || null;
    }
  } catch { /* not JSON — plaintext */ }
  return raw;
}

async function getDigikeyRefreshToken(): Promise<string | null> {
  if (cachedDigikeyRefreshToken) return cachedDigikeyRefreshToken;
  const row = await queryOne<{ refresh_token: string }>(
    `SELECT refresh_token FROM pricing_tokens WHERE provider = 'digikey'`
  );
  const unwrapped = unwrapStoredToken(row?.refresh_token);
  if (unwrapped) {
    cachedDigikeyRefreshToken = unwrapped;
  } else {
    // Check pricing_api_keys table first, then fall back to .env
    const token = await getPricingCredential('digikey', 'refresh_token', 'DIGIKEY_REFRESH_TOKEN');
    if (token) {
      cachedDigikeyRefreshToken = token;
      await setDigikeyRefreshToken(cachedDigikeyRefreshToken);
    }
  }
  return cachedDigikeyRefreshToken;
}

async function setDigikeyRefreshToken(token: string): Promise<void> {
  cachedDigikeyRefreshToken = token;
  const envelope = encryptCreds({ token });
  await query(
    `INSERT INTO pricing_tokens (provider, refresh_token, updated_at) VALUES ('digikey', $1, now())
     ON CONFLICT (provider) DO UPDATE SET refresh_token = EXCLUDED.refresh_token, updated_at = now()`,
    [JSON.stringify(envelope)]
  );
}

// DigiKey issues a NEW refresh token on every refresh and invalidates the old
// one immediately. Two concurrent refreshes therefore kill each other: the
// second presents a token DigiKey has already retired. A bulk price run makes
// exactly that pattern likely, so collapse concurrent refreshes into one.
let digikeyRefreshInFlight: Promise<string> | null = null;

async function getDigikeyToken(): Promise<string> {
  if (digikeyAccessToken && digikeyAccessToken.expiresAt > Date.now() + 5000) return digikeyAccessToken.token;
  if (digikeyRefreshInFlight) return digikeyRefreshInFlight;
  digikeyRefreshInFlight = refreshDigikeyToken().finally(() => { digikeyRefreshInFlight = null; });
  return digikeyRefreshInFlight;
}

async function refreshDigikeyToken(): Promise<string> {
  const clientId = await getPricingCredential('digikey', 'client_id', 'DIGIKEY_CLIENT_ID');
  const clientSecret = await getPricingCredential('digikey', 'client_secret', 'DIGIKEY_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('DigiKey credentials not configured');

  // 2-legged client_credentials: verified working on this account against
  // /products/v4/search/keyword. No browser, no user consent, no refresh token
  // to rotate or expire — which removes the whole class of failures that made
  // this need re-authorizing. The 3-legged refresh flow is kept below purely as
  // a fallback for accounts where client_credentials is not enabled.
  const ccRes = await fetch('https://api.digikey.com/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  if (ccRes.ok) {
    const cc: any = await ccRes.json();
    if (cc.access_token) {
      digikeyAccessToken = { token: cc.access_token, expiresAt: Date.now() + (cc.expires_in ?? 600) * 1000 };
      return digikeyAccessToken.token;
    }
  }

  // Fallback: authorization-code refresh token.
  const refreshToken = await getDigikeyRefreshToken();
  if (!refreshToken) {
    throw new Error(`DigiKey client_credentials was rejected (${ccRes.status}) and no refresh token is stored — run "npm run digikey:authorize"`);
  }
  const res = await fetch('https://api.digikey.com/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    // Do NOT blindly discard the stored token. DigiKey rotates the refresh token
    // on every use, so the stored copy is usually the only valid one — dropping
    // it and falling back to .env (which still holds the original, already
    // consumed token) turns a recoverable failure into a permanent one. Only
    // reach for .env when it genuinely differs, i.e. after a re-authorization.
    if (res.status === 400 || res.status === 401) {
      const envToken = await getPricingCredential('digikey', 'refresh_token', 'DIGIKEY_REFRESH_TOKEN');
      if (envToken && envToken !== refreshToken) {
        console.warn('[DIGIKEY] stored refresh token rejected; adopting the newer token from .env.');
        await setDigikeyRefreshToken(envToken);
        throw new Error('DigiKey token refreshed from .env — retry the request.');
      }
    }
    throw new Error(`DigiKey token refresh failed (${res.status}) — re-run "npm run digikey:authorize"`);
  }
  const data: any = await res.json();
  digikeyAccessToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await setDigikeyRefreshToken(data.refresh_token);
  }
  return digikeyAccessToken.token;
}

// Given an ascending price-break ladder, return the break whose quantity is
// the largest still <= the target qty (the price you actually pay at that
// order size). Falls back to the smallest break when the target is below all.
function pickBreakForQty<T>(breaks: T[], qty: number, getQty: (b: T) => number): T | null {
  if (!breaks || !breaks.length) return null;
  let chosen: T | null = null;
  for (const b of breaks) {
    const bq = getQty(b);
    if (bq <= qty && (chosen === null || bq >= getQty(chosen))) chosen = b;
  }
  return chosen ?? breaks[0];
}

async function searchDigikey(partNumber: string, qty = 1) {
  const token = await getDigikeyToken();
  const res = await fetch('https://api.digikey.com/products/v4/search/keyword', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-DIGIKEY-Client-Id': (await getPricingCredential('digikey', 'client_id', 'DIGIKEY_CLIENT_ID'))!,
      'X-DIGIKEY-Locale-Site': (await getPricingCredential('digikey', 'locale_site', 'DIGIKEY_LOCALE_SITE')) || 'ZA',
      'X-DIGIKEY-Locale-Language': (await getPricingCredential('digikey', 'locale_language', 'DIGIKEY_LOCALE_LANGUAGE')) || 'en',
      'X-DIGIKEY-Locale-Currency': (await getPricingCredential('digikey', 'locale_currency', 'DIGIKEY_LOCALE_CURRENCY')) || 'ZAR',
      'X-DIGIKEY-Locale-ShipToCountry': (await getPricingCredential('digikey', 'locale_ship_to_country', 'DIGIKEY_LOCALE_SHIP_TO_COUNTRY')) || 'ZA',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ Keywords: partNumber, Limit: 5 }),
  });
  if (!res.ok) throw new Error(`DigiKey search failed: ${res.status}`);
  const data: any = await res.json();
  const product = data.Products?.[0];
  if (!product) return null;
  const variation = product.ProductVariations?.[0];
  const pricing: any[] = variation?.StandardPricing ?? [];
  const chosen = pickBreakForQty(pricing, qty, (b) => Number(b.BreakQuantity) || 1);
  const unitPrice = chosen?.UnitPrice ?? product.UnitPrice ?? null;
  return {
    partNumber: product.ManufacturerProductNumber,
    manufacturer: product.Manufacturer?.Value ?? product.Manufacturer?.Name,
    unitPrice,
    breakQuantity: chosen?.BreakQuantity ?? null,
    // Currency follows the locale header, not a fixed assumption — DigiKey
    // ZA/ZAR pricing is ~18x the USD figure, so mislabeling it is a real money mistake.
    currency: (await getPricingCredential('digikey', 'locale_currency', 'DIGIKEY_LOCALE_CURRENCY')) || 'ZAR',
    stock: product.QuantityAvailable ?? null,
    productUrl: product.ProductUrl ?? null,
  };
}

async function searchMouser(partNumber: string, qty = 1) {
  const apiKey = await getPricingCredential('mouser', 'api_key', 'MOUSER_API_KEY');
  if (!apiKey) throw new Error('Mouser API key not configured');
  const res = await fetch(`https://api.mouser.com/api/v1/search/keyword?apiKey=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ SearchByKeywordRequest: { keyword: partNumber, records: 5, searchOptions: 'None' } }),
  });
  if (!res.ok) throw new Error(`Mouser search failed: ${res.status}`);
  const data: any = await res.json();
  const part = data.SearchResults?.Parts?.[0];
  if (!part) return null;
  const breaks: any[] = part.PriceBreaks ?? [];
  const priceBreak = pickBreakForQty(breaks, qty, (b) => Number(b.Quantity) || 1) ?? breaks[0];
  // Mouser's Price field is a formatted string like "R12.5000" or "$0.4700" — the currency
  // symbol is embedded in the text, not a separate field, so pull it out rather than assume USD.
  const rawPrice = priceBreak ? String(priceBreak.Price) : '';
  const priceNum = rawPrice ? Number(rawPrice.replace(/[^0-9.]/g, '')) : null;
  const currencySymbol = rawPrice.match(/^[^\d.]+/)?.[0]?.trim() || priceBreak?.Currency || null;
  const stockNum = part.Availability ? Number(String(part.Availability).replace(/[^0-9]/g, '')) : null;
  return {
    partNumber: part.ManufacturerPartNumber,
    manufacturer: part.Manufacturer,
    unitPrice: Number.isFinite(priceNum) ? priceNum : null,
    breakQuantity: priceBreak?.Quantity ?? null,
    currency: currencySymbol,
    stock: Number.isFinite(stockNum) ? stockNum : null,
    productUrl: part.ProductDetailUrl ?? null,
  };
}

// ---------------------------------------------------------------------------
// LCSC live lookup — no official API, but their public search endpoint returns
// JSON. Used as a fallback when the scrape cache doesn't have the part.
// ---------------------------------------------------------------------------
async function searchLcscLive(partNumber: string, _qty = 1) {
  const res = await fetch(
    `https://www.lcsc.com/api/products/search?q=${encodeURIComponent(partNumber)}&current_page=1&per_page=5`,
    {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    }
  );
  if (!res.ok) throw new Error(`LCSC search failed: ${res.status}`);
  // LCSC answers 200 with the storefront HTML when the JSON API is unavailable
  // to unauthenticated callers, which previously surfaced as a raw
  // "Unexpected token '<'" parse error. Detect it and say what to do instead:
  // the lcsc_price_cache table is fed by POST /api/pricing/lcsc/import.
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    throw new Error('LCSC live lookup unavailable (returned HTML, not JSON) — feed prices via the LCSC import endpoint instead');
  }
  const data: any = await res.json();
  // Response shape varies — try several known structures defensively.
  const products: any[] = data?.result?.productList ?? data?.productList ?? data?.data?.productList ?? data?.result?.list ?? [];
  const product = products[0];
  if (!product) return null;

  // Price can be a string ("0.1234"), a number, or nested in a priceList array.
  let unitPrice: number | null = null;
  if (typeof product.price === 'string' || typeof product.price === 'number') {
    unitPrice = Number(product.price);
  } else if (Array.isArray(product.priceList) && product.priceList.length > 0) {
    // priceList is typically [{l: 1, p: "0.50"}, {l: 10, p: "0.40"}, ...]
    const breaks = product.priceList;
    const chosen = pickBreakForQty(breaks, _qty, (b: any) => Number(b.l) || 1);
    unitPrice = chosen ? Number(chosen.p) : Number(breaks[0]?.p);
  } else if (product.productPrice != null) {
    unitPrice = Number(product.productPrice);
  }

  const stockRaw = product.stock ?? product.inStock ?? product.quantity;
  const stockNum = stockRaw != null ? Number(String(stockRaw).replace(/[^0-9]/g, '')) : null;

  const lcscPart = product.lcsc_part ?? product.productCode ?? product.lcscPartNumber;
  const mpn = product.mfr_part ?? product.manufacturer_part ?? product.mfrPartNumber ?? product.mpn;
  const manufacturer = product.mfr ?? product.manufacturer_name ?? product.manufacturerName;
  const productUrl = product.product_url ?? product.url ?? (lcscPart ? `https://www.lcsc.com/product-detail/${lcscPart}.html` : null);

  return {
    partNumber: lcscPart ?? mpn,
    manufacturer: manufacturer ?? null,
    unitPrice: Number.isFinite(unitPrice) ? unitPrice : null,
    breakQuantity: null,
    currency: 'USD',
    stock: Number.isFinite(stockNum) ? stockNum : null,
    productUrl,
  };
}

// ---------------------------------------------------------------------------
// Nexar (formerly Octopart) — aggregator API that returns offers from many
// suppliers at once (Arrow, Heilind, Avnet, TME, etc.). Requires an API key
// pair; covers suppliers that have no direct integration of their own.
// ---------------------------------------------------------------------------
let nexarAccessToken: { token: string; expiresAt: number } | null = null;

async function getNexarToken(): Promise<string> {
  if (nexarAccessToken && nexarAccessToken.expiresAt > Date.now() + 5000) return nexarAccessToken.token;
  const clientId = await getPricingCredential('nexar', 'api_key', 'NEXAR_API_KEY');
  const clientSecret = await getPricingCredential('nexar', 'api_secret', 'NEXAR_API_SECRET');
  if (!clientId || !clientSecret) throw new Error('Nexar credentials not configured');
  const res = await fetch('https://identity.nexar.com/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`Nexar token failed: ${res.status}`);
  const data: any = await res.json();
  nexarAccessToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 600) * 1000 };
  return nexarAccessToken.token;
}

async function searchNexar(partNumber: string, qty = 1) {
  const token = await getNexarToken();
  // Schema-verified against the live endpoint by introspection. The previous
  // query used `items { ... offers { sku { name } inStockQuantity product { url } } }`,
  // none of which exist: supSearch returns SupPartResultSet.results, each with a
  // `part`, and offers hang off part.sellers[].offers with scalar `sku`,
  // `inventoryLevel` and `clickUrl`. That mismatch was the hard 400.
  const gql = `query Search($q: String!) {
    supSearch(q: $q, limit: 5) {
      results {
        part {
          mpn
          octopartUrl
          manufacturer { name }
          sellers {
            company { name }
            isAuthorized
            offers {
              sku
              inventoryLevel
              moq
              clickUrl
              prices { quantity price currency }
            }
          }
        }
      }
    }
  }`;
  const res = await fetch('https://api.nexar.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gql, variables: { q: partNumber } }),
  });
  if (!res.ok) throw new Error(`Nexar search failed: ${res.status}`);
  const data: any = await res.json();
  // Nexar answers 200 with a GraphQL `errors` array for plan/quota problems, so
  // surface that text instead of silently reporting "no match". A Supply plan
  // with no part allowance returns "You have exceeded your part limit of 0".
  if (Array.isArray(data?.errors) && data.errors.length) {
    const msg = String(data.errors[0]?.message ?? 'Nexar returned an error');
    throw new Error(/part limit/i.test(msg) ? `Nexar plan has no Supply API quota — ${msg}` : msg);
  }
  const items = (data?.data?.supSearch?.results ?? [])
    .map((r: any) => r?.part)
    .filter(Boolean);
  if (!items.length) return null;

  // Collect all offers across all distributors, pick the best price for qty.
  let bestPrice: number | null = null;
  let bestOffer: any = null;
  let bestDistributor: string | null = null;
  let bestStock: number | null = null;
  let bestUrl: string | null = null;
  let matchedMpn: string | null = null;
  let matchedManufacturer: string | null = null;

  let bestCurrency: string | null = null;
  for (const item of items) {
    matchedMpn = matchedMpn ?? item.mpn;
    matchedManufacturer = matchedManufacturer ?? item.manufacturer?.name;
    // Offers live under sellers[], not directly on the part.
    for (const seller of item.sellers ?? []) {
      for (const offer of seller.offers ?? []) {
        const breaks: any[] = offer.prices ?? [];
        const chosen = pickBreakForQty(breaks, qty, (b) => Number(b.quantity) || 1) ?? breaks[0];
        const price = chosen ? Number(chosen.price) : null;
        if (price != null && Number.isFinite(price) && (bestPrice == null || price < bestPrice)) {
          bestPrice = price;
          bestOffer = offer;
          bestDistributor = seller.company?.name ?? offer.sku ?? null;
          bestStock = offer.inventoryLevel != null ? Number(offer.inventoryLevel) : null;
          bestUrl = offer.clickUrl ?? item.octopartUrl ?? null;
          // Each price break carries its own currency; do not assume USD.
          bestCurrency = chosen?.currency ?? bestCurrency;
        }
      }
    }
  }

  if (bestPrice == null) return null;

  return {
    partNumber: matchedMpn,
    manufacturer: matchedManufacturer,
    unitPrice: bestPrice,
    breakQuantity: null,
    currency: bestCurrency ?? 'USD',
    stock: bestStock,
    productUrl: bestUrl,
    // Extra metadata: which distributor had the best price.
    distributor: bestDistributor,
  };
}

// ---------------------------------------------------------------------------
// Element14 / Farnell / Newark (Avnet) — free REST API with an API key.
// storeInfo.id selects the regional store (e.g. "za" for South Africa).
// ---------------------------------------------------------------------------
// element14 has no ZA storefront on the API, so South African users read the UK
// catalogue. Currency follows the store, and is reported rather than assumed —
// converting a GBP figure as though it were USD would misprice by ~25%.
// Providers report currency inconsistently: Mouser embeds a symbol in the price
// string ("$0.47", "R12.50"), DigiKey follows the locale header, element14 the
// store, and Nexar puts an ISO code on each price break. Normalise to ISO so
// downstream conversion never has to guess from a glyph.
function normaliseCurrency(raw: string | null | undefined): string {
  const v = String(raw ?? '').trim().toUpperCase();
  if (!v) return 'USD';
  if (v.includes('ZAR') || v === 'R') return 'ZAR';
  if (v.includes('GBP') || v.includes('£')) return 'GBP';
  if (v.includes('EUR') || v.includes('€')) return 'EUR';
  if (v.includes('USD') || v.includes('$')) return 'USD';
  return v;
}

const ELEMENT14_DEFAULT_STORE = 'uk.farnell.com';

// Earlier guidance told users to set a bare country code, so accept those and
// map them to the real store domain rather than 400-ing on a value we suggested.
// 'za' maps to the UK store: element14 serves South Africa from that catalogue.
const ELEMENT14_STORE_ALIASES: Record<string, string> = {
  za: 'uk.farnell.com',
  uk: 'uk.farnell.com',
  gb: 'uk.farnell.com',
  us: 'us.newark.com',
  ca: 'canada.newark.com',
  au: 'au.element14.com',
  sg: 'sg.element14.com',
  de: 'de.farnell.com',
  fr: 'fr.farnell.com',
  it: 'it.farnell.com',
  es: 'es.farnell.com',
  nl: 'nl.farnell.com',
  ie: 'ie.farnell.com',
};

function normaliseElement14Store(raw: string | undefined): string {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return ELEMENT14_DEFAULT_STORE;
  if (ELEMENT14_STORE_ALIASES[v]) return ELEMENT14_STORE_ALIASES[v];
  // Anything without a dot is not a store domain; fall back rather than 400.
  return v.includes('.') ? v : ELEMENT14_DEFAULT_STORE;
}
const ELEMENT14_STORE_CURRENCY: Record<string, string> = {
  'uk.farnell.com': 'GBP',
  'us.newark.com': 'USD',
  'canada.newark.com': 'CAD',
  'au.element14.com': 'AUD',
  'sg.element14.com': 'SGD',
  'de.farnell.com': 'EUR',
  'fr.farnell.com': 'EUR',
  'it.farnell.com': 'EUR',
  'es.farnell.com': 'EUR',
  'nl.farnell.com': 'EUR',
  'ie.farnell.com': 'EUR',
};

async function searchElement14(partNumber: string, qty = 1) {
  const apiKey = await getPricingCredential('element14', 'api_key', 'ELEMENT14_API_KEY');
  if (!apiKey) throw new Error('Element14 API key not configured');
  // storeInfo.id must be a full store DOMAIN. Verified against the live API:
  // 'uk.farnell.com' returns results, while 'za' and 'za.farnell.com' both 400 —
  // element14 has no South African store, so ZA defaults to the UK catalogue.
  const storeId = normaliseElement14Store(
    await getPricingCredential('element14', 'store_id', 'ELEMENT14_STORE_ID')
  );
  const params = new URLSearchParams({
    // Parameter names are case-sensitive: callInfo.* (capital I) and a
    // term=manuPartNum:<mpn> search. The previous searchPart / callinfo.*
    // spelling was rejected with a bare 400.
    'term': `manuPartNum:${partNumber}`,
    'storeInfo.id': storeId,
    'resultsSettings.offset': '0',
    'resultsSettings.numberOfResults': '5',
    'resultsSettings.responseGroup': 'large',
    'callInfo.omitXmlSchema': 'false',
    'callInfo.apiKey': apiKey,
    'callInfo.responseDataFormat': 'json',
  });
  const res = await fetch(`https://api.element14.com/catalog/products?${params.toString()}`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) {
    if (res.status === 403) throw new Error('Element14 rate limit reached (queries per second)');
    throw new Error(`Element14 search failed: ${res.status}${res.status === 400 ? ` — check ELEMENT14_STORE_ID ("${storeId}"); it must be a store domain such as uk.farnell.com` : ''}`);
  }
  const data: any = await res.json();
  // Results arrive under a search-specific root key, not a flat `products`.
  const root: any = data?.manufacturerPartNumberSearchReturn ?? data?.premierFarnellPartNumberReturn ?? data?.keywordSearchReturn ?? data;
  const products: any[] = root?.products ?? [];
  const product = products[0];
  if (!product) return null;

  // Price breaks are {from, to, cost} — the amount field is `cost`, not `price`.
  const breaks: any[] = product.prices ?? [];
  const chosen = pickBreakForQty(breaks, qty, (b) => Number(b.from) || 1) ?? breaks[0];
  const priceNum = chosen != null ? Number(chosen.cost) : null;
  // stock is an object ({level, breakdown, ...}), not a scalar.
  const stockNum = Number(product.stock?.level);

  return {
    partNumber: product.translatedManufacturerPartNumber ?? product.manufacturerPartNumber ?? product.sku,
    manufacturer: product.brandName ?? product.vendorName ?? null,
    unitPrice: Number.isFinite(priceNum) ? priceNum : null,
    breakQuantity: chosen?.from ?? null,
    currency: ELEMENT14_STORE_CURRENCY[storeId] ?? 'GBP',
    stock: Number.isFinite(stockNum) ? stockNum : null,
    productUrl: product.sku ? `https://${storeId}/${product.sku}` : null,
    distributor: `element14 (${storeId})`,
  };
}

// ---------------------------------------------------------------------------
// TME (Transfer Multisort Elektronik) — REST API with HMAC-SHA1 signing.
// The signature is HMAC-SHA1 of the sorted, URL-encoded query string, keyed
// by the API secret. Covers a broad catalogue of European/Asian components.
// ---------------------------------------------------------------------------
async function searchTme(partNumber: string, qty = 1) {
  const apiKey = await getPricingCredential('tme', 'api_key', 'TME_API_KEY');
  const apiSecret = await getPricingCredential('tme', 'api_secret', 'TME_API_SECRET');
  if (!apiKey || !apiSecret) throw new Error('TME credentials not configured');

  // TME signs like OAuth 1.0, not with a bare query-string HMAC. The base string
  // is METHOD & rawurlencode(endpoint) & rawurlencode(sorted params), the request
  // is a form POST, the key parameter is `Token`, and the signature travels as
  // `ApiSignature`. The previous implementation got all of those wrong and would
  // have failed on every call.
  const endpoint = 'https://api.tme.eu/Products/Search.json';
  const params: Record<string, string> = {
    Token: apiKey,
    Country: 'PL',
    Language: 'EN',
    SearchPlain: partNumber,
  };

  // RFC3986: encodeURIComponent leaves !'()* alone, but the signature must treat
  // them as reserved or the digest will not match TME's.
  const rfc3986 = (s: string) =>
    encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

  const sortedQuery = Object.keys(params).sort()
    .map(k => `${rfc3986(k)}=${rfc3986(params[k])}`)
    .join('&');
  const signatureBase = `POST&${rfc3986(endpoint)}&${rfc3986(sortedQuery)}`;
  const apiSignature = createHmac('sha1', apiSecret).update(signatureBase).digest('base64');

  const body = new URLSearchParams({ ...params, ApiSignature: apiSignature });
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      // TME distinguishes anonymous from customer-linked calls via this header.
      // Catalogue and price endpoints are reachable with an anonymous token, so
      // no customer account linking (and no 10-minute Temporary Token) is needed.
      'request-context': 'anonymous',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    // TME returns a JSON body describing the fault; surface it rather than a bare code.
    let detail = '';
    try {
      const errBody: any = await res.json();
      detail = errBody?.Status || errBody?.Error || errBody?.ErrorMessage || '';
    } catch { /* non-JSON error body */ }
    throw new Error(`TME search failed: ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  const data: any = await res.json();
  // TME responds in PascalCase: { Status, Data: { ProductList: [...] } }.
  const products: any[] = data?.Data?.ProductList ?? data?.data?.productList ?? [];
  const product = products[0];
  if (!product) return null;

  const symbol: string | undefined = product.Symbol ?? product.symbol;

  // Search returns catalogue entries WITHOUT pricing — TME serves prices from a
  // separate endpoint keyed by the product symbol, so a second signed call is
  // required. Without it this provider could only ever report "no price".
  let chosen: any = null;
  let currency: string | null = null;
  if (symbol) {
    try {
      const priceParams: Record<string, string> = {
        Token: apiKey,
        Country: 'PL',
        Language: 'EN',
        'SymbolList[0]': symbol,
      };
      const priceEndpoint = 'https://api.tme.eu/Products/GetPrices.json';
      const priceQuery = Object.keys(priceParams).sort()
        .map(k => `${rfc3986(k)}=${rfc3986(priceParams[k])}`)
        .join('&');
      const priceSig = createHmac('sha1', apiSecret)
        .update(`POST&${rfc3986(priceEndpoint)}&${rfc3986(priceQuery)}`)
        .digest('base64');
      const priceRes = await fetch(priceEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'request-context': 'anonymous',
        },
        body: new URLSearchParams({ ...priceParams, ApiSignature: priceSig }).toString(),
      });
      if (priceRes.ok) {
        const pd: any = await priceRes.json();
        currency = pd?.Data?.Currency ?? null;
        const entry = (pd?.Data?.ProductList ?? [])[0];
        const breaks: any[] = entry?.PriceList ?? [];
        chosen = pickBreakForQty(breaks, qty, (b) => Number(b.Amount) || 1) ?? breaks[0] ?? null;
      }
    } catch {
      // Leave the price null rather than failing the whole lookup: the catalogue
      // match is still useful on its own.
    }
  }

  const priceNum = chosen != null ? Number(chosen.PriceValue ?? chosen.PriceNet) : null;
  const stockNum = Number(product.Amount ?? product.amountInStock);

  return {
    partNumber: product.OriginalSymbol ?? symbol ?? null,
    manufacturer: product.Producer ?? product.producer ?? null,
    unitPrice: Number.isFinite(priceNum) ? priceNum : null,
    breakQuantity: chosen?.Amount ?? null,
    currency: currency ?? 'PLN',
    stock: Number.isFinite(stockNum) ? stockNum : null,
    productUrl: symbol ? `https://www.tme.eu/en/details/${symbol}` : null,
    distributor: 'TME',
  };
}

// Cache lifetimes. Interactive lookups want something close to live; the bulk
// refresh deliberately reuses much older entries so a re-run costs no API calls.
const PRICING_CACHE_DEFAULT_MS = 24 * 60 * 60 * 1000;
const PRICING_CACHE_BULK_MS = 30 * 24 * 60 * 60 * 1000;

async function cachedProviderLookup(
  provider: 'digikey' | 'mouser' | 'nexar' | 'element14' | 'tme',
  partNumber: string,
  qty: number,
  maxAgeMs: number
): Promise<{ result: any; fromCache: boolean; calledApi: boolean }> {
  const cached = await queryOne<any>(
    `SELECT * FROM pricing_cache WHERE provider = $1 AND part_number = $2 AND qty = $3 ORDER BY created_at DESC LIMIT 1`,
    [provider, partNumber, qty]
  );
  if (cached && Date.now() - new Date(cached.created_at).getTime() < maxAgeMs) {
    try {
      return { result: JSON.parse(cached.data), fromCache: true, calledApi: false };
    } catch {
      // fall through and re-fetch on unparseable cache content
    }
  }

  if ((await getPricingUsage(provider)) >= PRICING_DAILY_LIMIT) {
    return { result: { error: 'Daily limit reached' }, fromCache: false, calledApi: false };
  }

  // Contain per-provider failures: an expired DigiKey token used to throw all
  // the way out and abort the whole bulk run, losing the Mouser results too.
  let result: any;
  try {
    const searchFn = provider === 'digikey' ? searchDigikey
      : provider === 'mouser' ? searchMouser
      : provider === 'nexar' ? searchNexar
      : provider === 'element14' ? searchElement14
      : searchTme;
    result = (await searchFn(partNumber, qty)) ?? { error: 'No match found' };
  } catch (err: any) {
    // Don't cache a transport/auth failure — it is not a fact about the part.
    return { result: { error: err.message }, fromCache: false, calledApi: false };
  }

  await incrementPricingUsage(provider);
  await query(
    `INSERT INTO pricing_cache (provider, part_number, qty, data, created_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (provider, part_number, qty) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
    [provider, partNumber, qty, JSON.stringify(result)]
  );
  return { result, fromCache: false, calledApi: true };
}

const LcscImportItemSchema = z.object({
  partNumber: z.string().min(1), // LCSC catalog number, e.g. "C131443"
  mpn: z.string().optional(),   // manufacturer part number, for lookup by either key
  price: z.number().nullable().optional(),
  stock: z.number().int().nullable().optional(),
  currency: z.string().optional(),
  url: z.string().optional(),
});

function maskValue(val: string | undefined): string {
  if (!val) return '';
  if (val.length <= 8) return '••••';
  return val.slice(0, 4) + '••••' + val.slice(-4);
}

export function registerPricingRoutes(app: Express): void {
  app.get('/api/pricing/usage', async (_req, res) => {
    try {
      const [digikey, mouser, nexar, element14, tme] = await Promise.all([
        getPricingUsage('digikey'), getPricingUsage('mouser'),
        getPricingUsage('nexar'), getPricingUsage('element14'), getPricingUsage('tme'),
      ]);
      const lcscCount = await queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM lcsc_price_cache`);
      const lcscLast = await queryOne<{ updated_at: string }>(`SELECT MAX(updated_at) as updated_at FROM lcsc_price_cache`);
      res.json({
        digikey: {
          used: digikey,
          limit: PRICING_DAILY_LIMIT,
          configured: await isProviderConfigured('digikey'),
          // Actually try to obtain a token rather than merely checking that some
          // refresh token exists — the old check reported authorized: true while
          // every lookup was failing with a rejected token. With
          // client_credentials there is no refresh token to look for at all.
          authorized: await getDigikeyToken().then(() => true).catch(() => false),
          grant: 'client_credentials (falls back to refresh_token)',
        },
        mouser: { used: mouser, limit: PRICING_DAILY_LIMIT, configured: await isProviderConfigured('mouser') },
        lcsc: { cached: Number(lcscCount?.count ?? 0), lastUpdated: lcscLast?.updated_at ?? null, liveLookup: true },
        nexar: { used: nexar, limit: PRICING_DAILY_LIMIT, configured: await isProviderConfigured('nexar') },
        element14: { used: element14, limit: PRICING_DAILY_LIMIT, configured: await isProviderConfigured('element14') },
        tme: { used: tme, limit: PRICING_DAILY_LIMIT, configured: await isProviderConfigured('tme') },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/pricing/search', async (req, res) => {
    const requested = String(req.query.partNumber || '').trim();
    if (!requested) return res.status(400).json({ error: 'partNumber is required' });
    const qty = Math.max(1, Math.min(1_000_000, parseInt(String(req.query.qty || '1'), 10) || 1));
    const maxAgeDays = parseFloat(String(req.query.maxAgeDays || ''));
    const maxAgeMs = Number.isFinite(maxAgeDays) && maxAgeDays > 0
      ? maxAgeDays * 24 * 60 * 60 * 1000
      : PRICING_CACHE_DEFAULT_MS;

    // Translate an internal SKU to the item's manufacturer part number before
    // sending it to the suppliers. Users routinely type their own stock codes
    // (e.g. "ANT-001") expecting the lookup to know what they mean; without this
    // it went straight to DigiKey/Mouser as if it were an MFN and returned
    // nothing. Match is case-insensitive; the query is unaffected if the input
    // is not a known SKU.
    let partNumber = requested;
    let resolvedFromSku: { sku: string; name: string } | null = null;
    const skuMatch = await queryOne<{ serial_number: string; man_pn_1: string; name: string }>(
      `SELECT serial_number, man_pn_1, name FROM inventory
       WHERE deleted != true AND UPPER(TRIM(serial_number)) = UPPER($1) LIMIT 1`,
      [requested]
    );
    if (skuMatch && skuMatch.man_pn_1 && String(skuMatch.man_pn_1).trim() && String(skuMatch.man_pn_1).trim().toUpperCase() !== 'N/A') {
      partNumber = String(skuMatch.man_pn_1).trim();
      resolvedFromSku = { sku: skuMatch.serial_number, name: skuMatch.name };
    }

    // Distinguish a distributor stock code from a real manufacturer part number.
    // DigiKey codes always end in "-ND"; LCSC codes are "C" followed by digits.
    // Sending a distributor code to another distributor is what produces the
    // Pasternack RF-part-for-a-100nF-capacitor keyword-mismatch trap.
    const upper = partNumber.toUpperCase();
    const codeFormat: 'digikey' | 'lcsc' | 'mfn' =
      /-ND$/.test(upper) ? 'digikey'
        : /^C\d+$/.test(upper) ? 'lcsc'
          : 'mfn';

    // For DigiKey-coded parts, ask DigiKey what the real manufacturer part number
    // is BEFORE we hit anyone else. That upgrades the lookup for every other
    // provider — they get a real MFN, not an -ND stock code that means nothing
    // to them. Cheap: one extra DigiKey call, cached like any other lookup.
    let resolvedFromDigikeyCode: string | null = null;
    let digikeyPreLookupResult: any = null;
    if (codeFormat === 'digikey' && (await isProviderConfigured('digikey')) && (await getDigikeyRefreshToken())) {
      try {
        const lookup = await cachedProviderLookup('digikey', partNumber, qty, maxAgeMs);
        digikeyPreLookupResult = lookup.result;
        const mpn = lookup.result?.partNumber;
        if (typeof mpn === 'string' && mpn && mpn.toUpperCase() !== partNumber.toUpperCase()) {
          resolvedFromDigikeyCode = mpn;
          // Fan-out below sees the real MPN. DigiKey's own slot is filled from the
          // pre-lookup we already paid for — no second DigiKey call for -ND codes.
          partNumber = mpn;
        }
      } catch { /* fall through: original code goes to all providers */ }
    }

    const results: any = { partNumber, qty, codeFormat };
    if (resolvedFromSku) {
      results.searchedFor = requested;
      results.resolvedFromSku = resolvedFromSku;
    }
    if (resolvedFromDigikeyCode) {
      results.resolvedFromDigikeyCode = { code: upper, mpn: resolvedFromDigikeyCode };
    }
    // LCSC codes only mean something to LCSC and (sometimes) Nexar's aggregator.
    // Skip the other providers rather than let them fuzzy-match to unrelated
    // parts — the same trap that priced a 100nF capacitor at $241 via Pasternack.
    const skipForOtherDistributor = codeFormat === 'lcsc'
      ? { error: 'Skipped: LCSC-format code — this distributor does not recognise it' }
      : null;

    if (skipForOtherDistributor) {
      results.digikey = skipForOtherDistributor;
    } else if (digikeyPreLookupResult) {
      // Already paid for this call during -ND code resolution. Don't hit it twice.
      results.digikey = digikeyPreLookupResult;
    } else if (!(await isProviderConfigured('digikey'))) {
      results.digikey = { error: 'Not configured' };
    } else if (!(await getDigikeyRefreshToken())) {
      results.digikey = { error: 'Not authorized — run "npm run digikey:authorize"' };
    } else {
      try {
        const cached = await queryOne<any>(
          `SELECT * FROM pricing_cache WHERE provider = 'digikey' AND part_number = $1 AND qty = $2 ORDER BY created_at DESC LIMIT 1`,
          [partNumber, qty]
        );
        if (cached && new Date().getTime() - new Date(cached.created_at).getTime() < maxAgeMs) {
          results.digikey = JSON.parse(cached.data);
          results.digikeyCached = true;
        } else if ((await getPricingUsage('digikey')) >= PRICING_DAILY_LIMIT) {
          results.digikey = { error: 'Daily limit reached' };
        } else {
          const result = await searchDigikey(partNumber, qty);
          results.digikey = result ?? { error: 'No match found' };
          await incrementPricingUsage('digikey');
          await query(
            `INSERT INTO pricing_cache (provider, part_number, qty, data, created_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (provider, part_number, qty) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
            ['digikey', partNumber, qty, JSON.stringify(results.digikey)]
          );
        }
      } catch (err: any) {
        results.digikey = { error: err.message };
      }
    }

    if (skipForOtherDistributor) {
      results.mouser = skipForOtherDistributor;
    } else if (!(await isProviderConfigured('mouser'))) {
      results.mouser = { error: 'Not configured' };
    } else {
      try {
        const cached = await queryOne<any>(
          `SELECT * FROM pricing_cache WHERE provider = 'mouser' AND part_number = $1 AND qty = $2 ORDER BY created_at DESC LIMIT 1`,
          [partNumber, qty]
        );
        if (cached && new Date().getTime() - new Date(cached.created_at).getTime() < maxAgeMs) {
          results.mouser = JSON.parse(cached.data);
          results.mouserCached = true;
        } else if ((await getPricingUsage('mouser')) >= PRICING_DAILY_LIMIT) {
          results.mouser = { error: 'Daily limit reached' };
        } else {
          const result = await searchMouser(partNumber, qty);
          results.mouser = result ?? { error: 'No match found' };
          await incrementPricingUsage('mouser');
          await query(
            `INSERT INTO pricing_cache (provider, part_number, qty, data, created_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (provider, part_number, qty) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
            ['mouser', partNumber, qty, JSON.stringify(results.mouser)]
          );
        }
      } catch (err: any) {
        results.mouser = { error: err.message };
      }
    }

    // LCSC: check the scrape cache first, then fall back to a live lookup via
    // their public search endpoint. Upgrades LCSC from cache-only to live
    // without needing an API key.
    const lcscRow = await queryOne<any>(
      `SELECT * FROM lcsc_price_cache WHERE part_number = $1 OR mpn = $1 ORDER BY updated_at DESC LIMIT 1`,
      [partNumber]
    );
    if (lcscRow) {
      results.lcsc = {
        partNumber: lcscRow.part_number,
        manufacturer: lcscRow.mpn,
        unitPrice: lcscRow.price !== null ? Number(lcscRow.price) : null,
        currency: lcscRow.currency,
        stock: lcscRow.stock,
        productUrl: lcscRow.url,
        updatedAt: lcscRow.updated_at,
      };
    } else {
      try {
        if ((await getPricingUsage('lcsc')) >= PRICING_DAILY_LIMIT) {
          results.lcsc = { error: 'Daily limit reached' };
        } else {
          const lcscResult = await searchLcscLive(partNumber, qty);
          if (lcscResult) {
            results.lcsc = lcscResult;
            await incrementPricingUsage('lcsc');
            await query(
              `INSERT INTO lcsc_price_cache (part_number, mpn, price, currency, stock, url, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, now())
               ON CONFLICT (part_number) DO UPDATE SET
                 mpn = EXCLUDED.mpn, price = EXCLUDED.price, currency = EXCLUDED.currency,
                 stock = EXCLUDED.stock, url = EXCLUDED.url, updated_at = now()`,
              [lcscResult.partNumber ?? partNumber, lcscResult.manufacturer ?? null,
               lcscResult.unitPrice ?? null, lcscResult.currency ?? 'USD',
               lcscResult.stock ?? null, lcscResult.productUrl ?? null]
            );
          } else {
            results.lcsc = { error: 'No match found' };
          }
        }
      } catch (err: any) {
        results.lcsc = { error: err.message };
      }
    }

    // Nexar (Octopart aggregator) — covers Arrow, Heilind, Avnet, and many others.
    if (skipForOtherDistributor) {
      results.nexar = skipForOtherDistributor;
    } else if (!(await isProviderConfigured('nexar'))) {
      results.nexar = { error: 'Not configured' };
    } else {
      try {
        const cached = await queryOne<any>(
          `SELECT * FROM pricing_cache WHERE provider = 'nexar' AND part_number = $1 AND qty = $2 ORDER BY created_at DESC LIMIT 1`,
          [partNumber, qty]
        );
        if (cached && new Date().getTime() - new Date(cached.created_at).getTime() < maxAgeMs) {
          results.nexar = JSON.parse(cached.data);
          results.nexarCached = true;
        } else if ((await getPricingUsage('nexar')) >= PRICING_DAILY_LIMIT) {
          results.nexar = { error: 'Daily limit reached' };
        } else {
          const result = await searchNexar(partNumber, qty);
          results.nexar = result ?? { error: 'No match found' };
          await incrementPricingUsage('nexar');
          await query(
            `INSERT INTO pricing_cache (provider, part_number, qty, data, created_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (provider, part_number, qty) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
            ['nexar', partNumber, qty, JSON.stringify(results.nexar)]
          );
        }
      } catch (err: any) {
        results.nexar = { error: err.message };
      }
    }

    // Element14 / Farnell / Newark (Avnet)
    if (skipForOtherDistributor) {
      results.element14 = skipForOtherDistributor;
    } else if (!(await isProviderConfigured('element14'))) {
      results.element14 = { error: 'Not configured' };
    } else {
      try {
        const cached = await queryOne<any>(
          `SELECT * FROM pricing_cache WHERE provider = 'element14' AND part_number = $1 AND qty = $2 ORDER BY created_at DESC LIMIT 1`,
          [partNumber, qty]
        );
        if (cached && new Date().getTime() - new Date(cached.created_at).getTime() < maxAgeMs) {
          results.element14 = JSON.parse(cached.data);
          results.element14Cached = true;
        } else if ((await getPricingUsage('element14')) >= PRICING_DAILY_LIMIT) {
          results.element14 = { error: 'Daily limit reached' };
        } else {
          const result = await searchElement14(partNumber, qty);
          results.element14 = result ?? { error: 'No match found' };
          await incrementPricingUsage('element14');
          await query(
            `INSERT INTO pricing_cache (provider, part_number, qty, data, created_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (provider, part_number, qty) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
            ['element14', partNumber, qty, JSON.stringify(results.element14)]
          );
        }
      } catch (err: any) {
        results.element14 = { error: err.message };
      }
    }

    // TME (Transfer Multisort Elektronik)
    if (skipForOtherDistributor) {
      results.tme = skipForOtherDistributor;
    } else if (!(await isProviderConfigured('tme'))) {
      results.tme = { error: 'Not configured' };
    } else {
      try {
        const cached = await queryOne<any>(
          `SELECT * FROM pricing_cache WHERE provider = 'tme' AND part_number = $1 AND qty = $2 ORDER BY created_at DESC LIMIT 1`,
          [partNumber, qty]
        );
        if (cached && new Date().getTime() - new Date(cached.created_at).getTime() < maxAgeMs) {
          results.tme = JSON.parse(cached.data);
          results.tmeCached = true;
        } else if ((await getPricingUsage('tme')) >= PRICING_DAILY_LIMIT) {
          results.tme = { error: 'Daily limit reached' };
        } else {
          const result = await searchTme(partNumber, qty);
          results.tme = result ?? { error: 'No match found' };
          await incrementPricingUsage('tme');
          await query(
            `INSERT INTO pricing_cache (provider, part_number, qty, data, created_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (provider, part_number, qty) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
            ['tme', partNumber, qty, JSON.stringify(results.tme)]
          );
        }
      } catch (err: any) {
        results.tme = { error: err.message };
      }
    }

    res.json(results);
  });

  // Which manufacturer part numbers already have a cached price at a given
  // quantity, and how old it is. The bulk wizard uses this to leave freshly
  // priced parts out of the next run instead of spending API calls re-asking.
  app.get('/api/pricing/cache-status', async (req, res) => {
    const qty = Math.max(1, Math.min(1_000_000, parseInt(String(req.query.qty || '1000'), 10) || 1000));
    const maxAgeDays = Math.max(0, parseFloat(String(req.query.maxAgeDays || '30')) || 30);
    try {
      const { rows } = await query(
        `SELECT part_number,
                MAX(created_at) AS cached_at,
                EXTRACT(EPOCH FROM (now() - MAX(created_at))) / 86400 AS age_days
           FROM pricing_cache
          WHERE qty = $1
          GROUP BY part_number`,
        [qty]
      );
      const fresh: Record<string, { cachedAt: string; ageDays: number }> = {};
      let stale = 0;
      for (const r of rows as any[]) {
        const ageDays = Number(r.age_days);
        if (ageDays <= maxAgeDays) {
          fresh[r.part_number] = { cachedAt: r.cached_at, ageDays: Number(ageDays.toFixed(2)) };
        } else {
          stale++;
        }
      }
      res.json({ qty, maxAgeDays, freshCount: Object.keys(fresh).length, staleCount: stale, fresh });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/pricing/lcsc/import', async (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const importToken = await getPricingCredential('lcsc', 'import_token', 'LCSC_IMPORT_TOKEN');
    if (!importToken || token !== importToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const parsed = z.array(LcscImportItemSchema).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    for (const item of parsed.data) {
      await query(
        `INSERT INTO lcsc_price_cache (part_number, mpn, price, currency, stock, url, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (part_number) DO UPDATE SET
           mpn = EXCLUDED.mpn, price = EXCLUDED.price, currency = EXCLUDED.currency,
           stock = EXCLUDED.stock, url = EXCLUDED.url, updated_at = now()`,
        [item.partNumber, item.mpn ?? null, item.price ?? null, item.currency ?? 'USD', item.stock ?? null, item.url ?? null]
      );
    }
    res.json({ ok: true, imported: parsed.data.length });
  });

  // ---------------------------------------------------------------------------
  // API key management endpoints
  // GET  /api/pricing/keys       — list all providers, field definitions, and
  //                                whether each field has a value (DB or .env).
  // POST /api/pricing/keys       — save credentials for a provider to the DB.
  // POST /api/pricing/keys/test  — test a provider's credentials with a live search.
  // ---------------------------------------------------------------------------
  app.get('/api/pricing/keys', requireAdmin, async (_req, res) => {
    try {
      const providers = await Promise.all(PRICING_PROVIDERS.map(async (cfg) => {
        const dbCreds = await loadProviderCredentials(cfg.provider);
        const fields = cfg.fields.map((f) => {
          const dbVal = dbCreds[f.name];
          const envVal = process.env[f.envVar];
          const hasValue = !!(dbVal || envVal);
          const source = dbVal ? 'db' : envVal ? 'env' : null;
          return {
            name: f.name, label: f.label, envVar: f.envVar, type: f.type,
            required: f.required ?? false, help: f.help, hasValue, source,
            masked: maskValue(dbVal || envVal),
          };
        });
        return {
          provider: cfg.provider, label: cfg.label, description: cfg.description,
          configured: await isProviderConfigured(cfg.provider), fields,
        };
      }));
      res.json(providers);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/pricing/keys', requireAdmin, async (req, res) => {
    const { provider, credentials } = req.body as { provider: string; credentials: Record<string, string> };
    if (!provider || !credentials || typeof credentials !== 'object') {
      return res.status(400).json({ error: 'provider and credentials are required' });
    }
    const config = PRICING_PROVIDERS.find(p => p.provider === provider);
    if (!config) return res.status(400).json({ error: `Unknown provider: ${provider}` });
    const allowedFields = new Set(config.fields.map(f => f.name));
    const cleanCreds: Record<string, string> = {};
    for (const [key, val] of Object.entries(credentials)) {
      if (allowedFields.has(key) && typeof val === 'string' && val.trim() !== '') {
        cleanCreds[key] = val.trim();
      }
    }
    if (Object.keys(cleanCreds).length === 0) {
      return res.status(400).json({ error: 'No valid credential fields provided' });
    }
    try {
      const existing = await loadProviderCredentials(provider);
      const merged = { ...existing, ...cleanCreds };
      const envelope = encryptCreds(merged);
      await query(
        `INSERT INTO pricing_api_keys (provider, credentials, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (provider) DO UPDATE SET credentials = EXCLUDED.credentials, updated_at = now()`,
        [provider, JSON.stringify(envelope)]
      );
      invalidatePricingKeyCache(provider);
      if (provider === 'digikey') { digikeyAccessToken = null; cachedDigikeyRefreshToken = null; }
      if (provider === 'nexar') { nexarAccessToken = null; }
      res.json({ ok: true, provider, configured: await isProviderConfigured(provider) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/pricing/keys/test', requireAdmin, async (req, res) => {
    const { provider } = req.body as { provider: string };
    if (!provider) return res.status(400).json({ error: 'provider is required' });
    const config = PRICING_PROVIDERS.find(p => p.provider === provider);
    if (!config) return res.status(400).json({ error: `Unknown provider: ${provider}` });
    const testPart = 'STM32F103C8T6';
    try {
      if (!(await isProviderConfigured(provider))) {
        return res.json({ provider, success: false, error: 'Not all required credentials are set' });
      }
      const searchFn = provider === 'digikey' ? searchDigikey
        : provider === 'mouser' ? searchMouser
        : provider === 'nexar' ? searchNexar
        : provider === 'element14' ? searchElement14
        : provider === 'tme' ? searchTme : null;
      if (!searchFn) return res.json({ provider, success: false, error: 'No search function for this provider' });
      const result = await searchFn(testPart, 1);
      if (result && (result.unitPrice != null || result.partNumber)) {
        res.json({ provider, success: true, matchedPart: result.partNumber, unitPrice: result.unitPrice, currency: result.currency, stock: result.stock });
      } else {
        res.json({ provider, success: false, error: 'No match found — credentials may be valid but the test part was not found' });
      }
    } catch (err: any) {
      res.json({ provider, success: false, error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Bulk price refresh
  //
  // Populates inventory.bulk_price_zar from the supplier APIs. Results are cached
  // for 30 days (PRICING_CACHE_BULK_MS), so re-running costs no API calls for
  // parts already looked up — the cache is the point, not an optimisation.
  //
  // Only parts carrying a manufacturer/distributor part number can be searched;
  // the rest are reported as skipped rather than silently ignored. Defaults to a
  // dry run so a caller must opt in to writing to the inventory table.
  // ---------------------------------------------------------------------------
  app.post('/api/pricing/bulk-refresh', async (req, res) => {
    const body = req.body || {};
    const qty = Math.max(1, Math.min(1_000_000, parseInt(String(body.qty ?? 1000), 10) || 1000));
    const limit = Math.max(1, Math.min(1000, parseInt(String(body.limit ?? 250), 10) || 250));
    const dryRun = body.dryRun !== false; // write only when explicitly dryRun:false
    const onlyMissing = body.onlyMissing !== false;
    const maxAgeMs = PRICING_CACHE_BULK_MS;
    // Above this USD unit price a result is held back for review rather than
    // written. Most of this catalogue is passives costing well under a dollar.
    const suspiciousAboveUsd = Number.isFinite(Number(body.suspiciousAboveUsd))
      ? Number(body.suspiciousAboveUsd)
      : 50;

    try {
      const fx = await readExchangeRate();
      if (!fx.usdToZar) {
        return res.status(400).json({ error: 'No USD→ZAR rate stored; refresh the exchange rate before running a bulk price check.' });
      }

      const hasMpn = `(COALESCE(NULLIF(TRIM(man_pn_1),''),'') <> '' AND UPPER(TRIM(man_pn_1)) <> 'N/A')`;
      const noZar = `COALESCE(NULLIF(bulk_price_zar::text,'')::numeric,0) = 0`;
      const { rows: candidates } = await query(
        `SELECT serial_number, man_pn_1, stock FROM inventory
         WHERE deleted != true AND stock > 0 ${onlyMissing ? `AND ${noZar}` : ''} AND ${hasMpn}
         ORDER BY stock DESC LIMIT $1`,
        [limit]
      );

      const { rows: skippedRows } = await query(
        `SELECT COUNT(*)::int AS c FROM inventory
         WHERE deleted != true AND stock > 0 ${onlyMissing ? `AND ${noZar}` : ''} AND NOT ${hasMpn}`
      );

      const updated: any[] = [];
      const noPrice: any[] = [];
      const flagged: any[] = [];
      let apiCalls = 0;
      let cacheHits = 0;

      for (const item of candidates as any[]) {
        const mpn = String(item.man_pn_1).trim();
        const [dk, mo, nx, e14, tme] = [
          await cachedProviderLookup('digikey', mpn, qty, maxAgeMs),
          await cachedProviderLookup('mouser', mpn, qty, maxAgeMs),
          await cachedProviderLookup('nexar', mpn, qty, maxAgeMs),
          await cachedProviderLookup('element14', mpn, qty, maxAgeMs),
          await cachedProviderLookup('tme', mpn, qty, maxAgeMs),
        ];
        apiCalls += (dk.calledApi ? 1 : 0) + (mo.calledApi ? 1 : 0) + (nx.calledApi ? 1 : 0) + (e14.calledApi ? 1 : 0) + (tme.calledApi ? 1 : 0);
        cacheHits += (dk.fromCache ? 1 : 0) + (mo.fromCache ? 1 : 0) + (nx.fromCache ? 1 : 0) + (e14.fromCache ? 1 : 0) + (tme.fromCache ? 1 : 0);

        // These suppliers do a KEYWORD search and return the first hit, which is
        // not guaranteed to be the part asked for. String-matching the result
        // against the stored code does not work either: the stored values are
        // mangled distributor hybrids (e.g. '311-100KLRDKR-ND' carries Mouser's
        // 311- prefix and DigiKey's -ND suffix) that legitimately resolve to a
        // different manufacturer MPN. So always report what was matched, and flag
        // implausible prices for review rather than trusting the string.
        const toZar = (raw: any, provider: string) => {
          const price = Number(raw?.unitPrice);
          if (!Number.isFinite(price) || price <= 0) return null;
          // The price string carries its own currency symbol; a ZAR-denominated
          // account gets 'R' back, and converting that again would inflate it ~17x.
          const sym = String(raw?.currency ?? '').toUpperCase();
          const code = normaliseCurrency(sym);
          // Look up ZAR per <native currency> from the stored rate map. Element14
          // quotes GBP, TME quotes PLN, the EU stores quote EUR — all convertible
          // now that updateExchangeRate harvests them. A currency the map does
          // not carry still gets rejected rather than silently mispriced.
          const rateToZar = fx.ratesToZar?.[code];
          if (!Number.isFinite(rateToZar) || rateToZar <= 0) {
            return { rejected: `${provider} quoted ${code}, which has no stored conversion rate — refresh the exchange rate` };
          }
          const zarValue = code === 'ZAR' ? price : price * rateToZar;
          const usdEquivalent = fx.usdToZar ? zarValue / fx.usdToZar : NaN;
          return {
            provider,
            native: price,
            currency: code,
            usdEquivalent: Number.isFinite(usdEquivalent) ? Number(usdEquivalent.toFixed(4)) : null,
            zar: Number(zarValue.toFixed(4)),
            matchedPart: raw?.partNumber ?? null,
            matchedManufacturer: raw?.manufacturer ?? null,
          };
        };

        const offers = [
          toZar(dk.result, 'digikey'), toZar(mo.result, 'mouser'),
          toZar(nx.result, 'nexar'), toZar(e14.result, 'element14'), toZar(tme.result, 'tme'),
        ].filter(Boolean) as any[];

        if (!offers.length) {
          noPrice.push({
            partNumber: item.serial_number,
            mpn,
            reason: dk.result?.error || mo.result?.error || 'No price returned',
          });
          continue;
        }

        const best = offers.reduce((a, b) => (b.zar < a.zar ? b : a));
        // A passive component priced above this is almost certainly a bad keyword
        // match rather than a real cost — surface it instead of writing silently.
        const suspicious = best.usdEquivalent > suspiciousAboveUsd;

        if (suspicious) {
          flagged.push({
            partNumber: item.serial_number, mpn,
            matchedPart: best.matchedPart, matchedManufacturer: best.matchedManufacturer,
            provider: best.provider, native: best.native, currency: best.currency,
            usdEquivalent: best.usdEquivalent, zar: best.zar,
            reason: `Unit price ${best.usdEquivalent} USD exceeds the ${suspiciousAboveUsd} USD review threshold — likely a keyword mismatch.`,
          });
          continue;
        }

        if (!dryRun) {
          await query(`UPDATE inventory SET bulk_price_zar = $1 WHERE serial_number = $2`, [best.zar, item.serial_number]);
        }
        updated.push({
          partNumber: item.serial_number, mpn, provider: best.provider,
          matchedPart: best.matchedPart, matchedManufacturer: best.matchedManufacturer,
          native: best.native, currency: best.currency, zar: best.zar,
        });
      }

      res.json({
        dryRun,
        qty,
        rateUsed: fx.usdToZar,
        rateDate: fx.lastUpdated,
        cacheDays: Math.round(maxAgeMs / 86400000),
        candidates: candidates.length,
        priced: updated.length,
        flaggedForReview: flagged.length,
        noPriceFound: noPrice.length,
        skippedNoPartNumber: skippedRows[0]?.c ?? 0,
        suspiciousAboveUsd,
        apiCalls,
        cacheHits,
        updated: updated.slice(0, 100),
        flagged: flagged.slice(0, 50),
        noPrice: noPrice.slice(0, 50),
        note: dryRun
          ? 'Dry run — nothing written. Re-send with {"dryRun": false} to apply.'
          : `Wrote bulk_price_zar for ${updated.length} item(s).`,
      });
    } catch (err: any) {
      console.error('[BULK PRICING] failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/suppliers/compare-prices — pairs with the read-only supplier
  // routes in suppliersRoutes.ts. Lives here because it fans out through the
  // same provider clients and daily-usage counters as the rest of pricing.
  app.post('/api/suppliers/compare-prices', async (req, res) => {
    const { partNumbers, forceRefresh } = req.body;
    if (!Array.isArray(partNumbers) || partNumbers.length === 0) {
      return res.status(400).json({ error: 'partNumbers array required' });
    }

    try {
      const results: any[] = [];
      // Cache pricing data for 30 days to reduce API credit usage
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const twentyFourHoursAgo = thirtyDaysAgo; // Use 30-day cache window

      for (const partNumber of partNumbers) {
        const comparison = {
          partNumber,
          digikey: null as any,
          mouser: null as any,
          lcsc: null as any,
          bestPrice: null as any,
          bestSupplier: null as string | null,
        };

        // LCSC: check cache (always cached via scraper)
        const lcscCached = await queryOne<any>(
          'SELECT * FROM lcsc_price_cache WHERE part_number = $1 OR mpn = $1 ORDER BY updated_at DESC LIMIT 1',
          [partNumber]
        );
        if (lcscCached) {
          comparison.lcsc = {
            price: lcscCached.price,
            currency: lcscCached.currency || 'USD',
            stock: lcscCached.stock || 0,
            moq: 1,
            leadTime: 14,
            cached: true,
            updatedAt: lcscCached.updated_at,
          };
        }

        // DigiKey/Mouser: check 24-hr cache first, fall back to live API if stale or force refresh
        let digikeyFromCache = false, mouserFromCache = false;

        if (!forceRefresh) {
          const recentPrices = await query(
            `SELECT * FROM supplier_price_history
             WHERE part_number = $1 AND queried_at > $2`,
            [partNumber, twentyFourHoursAgo.toISOString()]
          );

          recentPrices.rows.forEach(row => {
            if (row.supplier === 'digikey') {
              comparison.digikey = {
                price: parseFloat(row.price),
                currency: row.currency || 'USD',
                stock: row.stock || 0,
                moq: row.moq || 1,
                leadTime: row.lead_time_days || 7,
                cached: true,
                updatedAt: row.queried_at,
              };
              digikeyFromCache = true;
            } else if (row.supplier === 'mouser') {
              comparison.mouser = {
                price: parseFloat(row.price),
                currency: row.currency || 'USD',
                stock: row.stock || 0,
                moq: row.moq || 1,
                leadTime: row.lead_time_days || 5,
                cached: true,
                updatedAt: row.queried_at,
              };
              mouserFromCache = true;
            }
          });
        }

        // DigiKey: fetch live if no cache hit
        if (!digikeyFromCache && await isProviderConfigured('digikey') && await getDigikeyRefreshToken()) {
          if ((await getPricingUsage('digikey')) < PRICING_DAILY_LIMIT) {
            try {
              await incrementPricingUsage('digikey');
              const digiKeyResult = await searchDigikey(partNumber, 1);
              if (digiKeyResult) {
                comparison.digikey = {
                  price: digiKeyResult.unitPrice,
                  currency: digiKeyResult.currency,
                  stock: digiKeyResult.stock || 0,
                  moq: digiKeyResult.breakQuantity || 1,
                  leadTime: 7,
                  cached: false,
                  updatedAt: new Date().toISOString(),
                };
                // Store in history for caching
                await query(
                  `INSERT INTO supplier_price_history (supplier, part_number, price, currency, stock, moq, lead_time_days, queried_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
                  ['digikey', partNumber, digiKeyResult.unitPrice || 0, digiKeyResult.currency, digiKeyResult.stock || 0, digiKeyResult.breakQuantity || 1, 7]
                ).catch(() => {});
              }
            } catch (err: any) {
              // silently fail live lookup, keep cached if available
            }
          }
        }

        // Mouser: fetch live if no cache hit
        if (!mouserFromCache && await isProviderConfigured('mouser')) {
          if ((await getPricingUsage('mouser')) < PRICING_DAILY_LIMIT) {
            try {
              await incrementPricingUsage('mouser');
              const mouserResult = await searchMouser(partNumber, 1);
              if (mouserResult) {
                comparison.mouser = {
                  price: mouserResult.unitPrice,
                  currency: mouserResult.currency,
                  stock: mouserResult.stock || 0,
                  moq: mouserResult.breakQuantity || 1,
                  leadTime: 5,
                  cached: false,
                  updatedAt: new Date().toISOString(),
                };
                // Store in history for caching
                await query(
                  `INSERT INTO supplier_price_history (supplier, part_number, price, currency, stock, moq, lead_time_days, queried_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
                  ['mouser', partNumber, mouserResult.unitPrice || 0, mouserResult.currency, mouserResult.stock || 0, mouserResult.breakQuantity || 1, 5]
                ).catch(() => {});
              }
            } catch (err: any) {
              // silently fail live lookup, keep cached if available
            }
          }
        }

        // Determine best price (lowest available)
        const validPrices = [
          comparison.digikey && { supplier: 'digikey', price: parseFloat(comparison.digikey.price) },
          comparison.mouser && { supplier: 'mouser', price: parseFloat(comparison.mouser.price) },
          comparison.lcsc && { supplier: 'lcsc', price: parseFloat(comparison.lcsc.price) },
        ].filter(Boolean) as any[];

        if (validPrices.length > 0) {
          const best = validPrices.reduce((a, b) => a.price < b.price ? a : b);
          comparison.bestPrice = best.price;
          comparison.bestSupplier = best.supplier;
        }

        results.push(comparison);
      }

      res.json({ comparisons: results });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
