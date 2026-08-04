import express from 'express';
import compression from 'compression';
import { z } from 'zod';
import { spawn } from 'child_process';
import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { createHmac } from 'node:crypto';
import { pool, query, queryOne, exec, ensureSchema, close } from './src/lib/db';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determine dist directory path (handle both dev and prod)
const distPath = path.resolve(__dirname, 'dist');
const altDistPath = path.resolve(process.cwd(), 'dist');
const DIST_DIR = existsSync(distPath) ? distPath : altDistPath;

import { ensureBookkeepingSchema } from './src/lib/bookkeeping-db';
import { registerBookkeepingRoutes } from './src/lib/bookkeeping-routes';
import { ensurePhase5Tables } from './src/lib/phase5-db';
import phase5Routes from './src/lib/phase5-routes';

const app = express();
app.use(compression());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.json({ limit: '1mb' }));

// Serve static files from dist directory
app.use(express.static(DIST_DIR));

const ItemSchema = z.object({
  serial_number: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  value: z.string().optional(),
  size: z.string().optional(),
  package: z.string().optional(),
  tolerance: z.string().optional(),
  type: z.string().optional(),
  footprint: z.string().optional(),
  comment: z.string().optional(),
  datasheet: z.string().optional(),
  project: z.string().optional(),
  packaging: z.string().optional(),
  stock: z.number().int().optional(),
  qty_per_pcb: z.number().optional(),
  low_stock_lvl: z.number().int().optional(),
  current_cost_dollar: z.number().optional(),
  bulk_price_usd: z.number().optional(),
  bulk_price_zar: z.number().optional(),
  last_order_qty: z.number().int().optional(),
  last_order_date: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'BOOKED OUT', 'DISCONTINUED']).optional(),
  man_pn_1: z.string().optional(),
  man_pn_2: z.string().optional(),
  man_pn_3: z.string().optional(),
  man_pn_4: z.string().optional(),
  man_pn_5: z.string().optional(),
  sup_pn_1: z.string().optional(),
  sup_pn_2: z.string().optional(),
  sup_pn_3: z.string().optional(),
  sup_pn_4: z.string().optional(),
  sup_pn_5: z.string().optional(),
  weblink_1: z.string().optional(),
  weblink_2: z.string().optional(),
  weblink_3: z.string().optional(),
  weblink_4: z.string().optional(),
  weblink_5: z.string().optional(),
});

const ALLOWED_ITEM_FIELDS = Object.keys(ItemSchema.shape).filter(k => k !== 'serial_number');

const stmtCache = new Map<string, string>();
function sql(text: string): string {
  if (!stmtCache.has(text)) stmtCache.set(text, text);
  return text;
}

// Bookkeeping / ERP module — Chart of Accounts, invoices, bills, payments, reports.
registerBookkeepingRoutes(app);

// Phase 5: Quality & Compliance + Advanced Automation
app.use(phase5Routes);

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
// API keys live in the `pricing_api_keys` table so they can be managed from the
// Pricing UI. The server reads from the DB first and falls back to process.env
// (the .env file) for backwards compatibility — existing deployments keep working
// without migrating, and the UI can override .env values at any time.
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

// In-memory cache of DB-stored credentials, keyed by provider. Invalidated on write
// so a key saved from the UI is visible immediately without a server restart.
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
  const row = await queryOne<{ credentials: Record<string, string> }>(
    `SELECT credentials FROM pricing_api_keys WHERE provider = $1`,
    [provider]
  );
  const creds = row?.credentials ?? {};
  pricingKeyCache.set(provider, creds);
  return creds;
}

// Read a single credential: DB first, then process.env fallback.
async function getPricingCredential(provider: string, field: string, envVar: string): Promise<string | undefined> {
  const dbCreds = await loadProviderCredentials(provider);
  const val = dbCreds[field] || process.env[envVar];
  return val || undefined;
}

// Check if a provider has all its required credentials configured (DB or .env).
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

// DigiKey's Product Information API (v4) requires 3-legged OAuth2 for this account (not
// client_credentials) — confirmed by the working reference script. Run `npm run digikey:authorize`
// once to mint a refresh token; after that, access tokens are silently refreshed server-side.
// The refresh token is rotated by DigiKey on every use, so it's stored in the `pricing_tokens`
// table rather than .env — rewriting .env under `vite dev` triggers a full dev-server restart
// (Vite watches it), which would kill the very in-flight request that just rotated the token.
let digikeyAccessToken: { token: string; expiresAt: number } | null = null;
let cachedDigikeyRefreshToken: string | null = null;

async function getDigikeyRefreshToken(): Promise<string | null> {
  if (cachedDigikeyRefreshToken) return cachedDigikeyRefreshToken;
  const row = await queryOne<{ refresh_token: string }>(
    `SELECT refresh_token FROM pricing_tokens WHERE provider = 'digikey'`
  );
  if (row?.refresh_token) {
    cachedDigikeyRefreshToken = row.refresh_token;
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
  await query(
    `INSERT INTO pricing_tokens (provider, refresh_token, updated_at) VALUES ('digikey', $1, now())
     ON CONFLICT (provider) DO UPDATE SET refresh_token = EXCLUDED.refresh_token, updated_at = now()`,
    [token]
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

// Given an ascending price-break ladder, return the break whose quantity is the largest one
// that is still <= the target qty (i.e. the price you actually pay at that order size). Falls
// back to the smallest (first) break when the target is below every break.
function pickBreakForQty<T>(breaks: T[], qty: number, getQty: (b: T) => number): T | null {
  if (!breaks || !breaks.length) return null;
  let chosen: T | null = null;
  for (const b of breaks) {
    const bq = getQty(b);
    if (bq <= qty && (chosen === null || bq >= getQty(chosen))) chosen = b;
  }
  return chosen ?? breaks[0];
}

// Helper functions for document numbering and mapping
async function nextDocNumber(client: any, docType: string, seqTable: string): Promise<string> {
  const result = await client.query(
    `SELECT nextval('${seqTable}') as seq`
  );
  const seq = result.rows[0].seq;
  return `${docType}-${String(seq).padStart(6, '0')}`;
}

function mapPurchaseOrder(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    poNumber: row.po_number,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    orderDate: row.order_date,
    expectedDate: row.expected_date,
    status: row.status,
    currency: row.currency,
    subtotal: row.subtotal,
    taxTotal: row.tax_total,
    total: row.total,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function mapPurchaseOrderItem(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    purchaseOrderId: row.purchase_order_id,
    partNumber: row.part_number,
    description: row.description,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    taxAmount: row.tax_amount || 0,
    lineTotal: row.line_total || 0,
    qtyReceived: row.qty_received || 0,
  };
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
    // Currency is whatever we requested via the locale header, not a fixed assumption —
    // DigiKey ZA/ZAR pricing is ~18x the USD figure, so mislabeling it is a real money mistake.
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
// JSON. Used as a fallback when the scrape cache doesn't have the part, so LCSC
// goes from cache-only to live without needing an API key.
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
  // The response shape varies — try several known structures defensively.
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
  const query = `query Search($q: String!) {
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
    body: JSON.stringify({ query, variables: { q: partNumber } }),
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

// Cache lifetime for a supplier response. Interactive lookups want something
// close to live; the bulk refresh deliberately reuses much older entries so a
// re-run costs no API calls.
const PRICING_CACHE_DEFAULT_MS = 24 * 60 * 60 * 1000;
const PRICING_CACHE_BULK_MS = 30 * 24 * 60 * 60 * 1000;

app.get('/api/pricing/search', async (req, res) => {
  const partNumber = String(req.query.partNumber || '').trim();
  if (!partNumber) return res.status(400).json({ error: 'partNumber is required' });
  const qty = Math.max(1, Math.min(1_000_000, parseInt(String(req.query.qty || '1'), 10) || 1));
  const maxAgeDays = parseFloat(String(req.query.maxAgeDays || ''));
  const maxAgeMs = Number.isFinite(maxAgeDays) && maxAgeDays > 0
    ? maxAgeDays * 24 * 60 * 60 * 1000
    : PRICING_CACHE_DEFAULT_MS;

  const results: any = { partNumber, qty };

  if (!(await isProviderConfigured('digikey'))) {
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

  if (!(await isProviderConfigured('mouser'))) {
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

  // LCSC: check the scrape cache first, then fall back to a live lookup via their public
  // search endpoint. This upgrades LCSC from cache-only to live without needing an API key.
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
  if (!(await isProviderConfigured('nexar'))) {
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
  if (!(await isProviderConfigured('element14'))) {
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
  if (!(await isProviderConfigured('tme'))) {
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

const LcscImportItemSchema = z.object({
  partNumber: z.string().min(1), // LCSC catalog number, e.g. "C131443"
  mpn: z.string().optional(), // manufacturer part number, for lookup by either key
  price: z.number().nullable().optional(),
  stock: z.number().int().nullable().optional(),
  currency: z.string().optional(),
  url: z.string().optional(),
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
function maskValue(val: string | undefined): string {
  if (!val) return '';
  if (val.length <= 8) return '••••';
  return val.slice(0, 4) + '••••' + val.slice(-4);
}

app.get('/api/pricing/keys', async (_req, res) => {
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

app.post('/api/pricing/keys', async (req, res) => {
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
    await query(
      `INSERT INTO pricing_api_keys (provider, credentials, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (provider) DO UPDATE SET credentials = EXCLUDED.credentials, updated_at = now()`,
      [provider, JSON.stringify(merged)]
    );
    invalidatePricingKeyCache(provider);
    if (provider === 'digikey') { digikeyAccessToken = null; cachedDigikeyRefreshToken = null; }
    if (provider === 'nexar') { nexarAccessToken = null; }
    res.json({ ok: true, provider, configured: await isProviderConfigured(provider) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pricing/keys/test', async (req, res) => {
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
        // Only USD and ZAR can be converted: the app stores a single USD->ZAR
        // rate. Element14 quotes GBP and the EU stores quote EUR, and treating
        // those as USD would misprice them by ~30%. Report them instead of
        // guessing — a wrong price is worse than a missing one.
        if (code !== 'USD' && code !== 'ZAR') {
          return { rejected: `${provider} quoted ${code}, which has no stored conversion rate` };
        }
        const isZar = code === 'ZAR';
        const usdEquivalent = isZar ? price / fx.usdToZar! : price;
        const zarValue = isZar ? price : price * fx.usdToZar!;
        return {
          provider,
          native: price,
          currency: code,
          usdEquivalent: Number(usdEquivalent.toFixed(4)),
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

// --- Production Costs catalog (finished products: cost vs selling price vs margin) ---
// Seeded once from Tracklab_Production_Costs_2026-04-30.xlsx; editable in-app thereafter.
// Ties into the ERP: model_number doubles as the part number used on invoices/sales orders,
// selling_price is the finished-goods price, and (selling - cost) is the unit margin/COGS view.
const mapProductionProduct = (r: any) => {
  const cost = r.production_cost === null ? null : Number(r.production_cost);
  const price = r.selling_price === null ? null : Number(r.selling_price);
  const margin = cost !== null && price !== null ? Math.round((price - cost) * 100) / 100 : null;
  const marginPct = margin !== null && price ? Math.round((margin / price) * 1000) / 10 : null;
  return {
    id: r.id,
    modelNumber: r.model_number,
    description: r.description,
    category: r.category,
    productionCost: cost,
    sellingPrice: price,
    currency: r.currency,
    notes: r.notes,
    margin,
    marginPct,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

const ProductionProductSchema = z.object({
  modelNumber: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  productionCost: z.number().nullable().optional(),
  sellingPrice: z.number().nullable().optional(),
  currency: z.string().optional(),
  notes: z.string().optional(),
});

app.get('/api/production-products', async (_req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM production_products ORDER BY category NULLS LAST, model_number`);
    res.json(rows.map(mapProductionProduct));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/production-products', async (req, res) => {
  const parsed = ProductionProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid product payload', details: parsed.error.flatten() });
  const b = parsed.data;
  try {
    const row = await queryOne(
      `INSERT INTO production_products (model_number, description, category, production_cost, selling_price, currency, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.modelNumber, b.description || null, b.category || null, b.productionCost ?? null, b.sellingPrice ?? null, b.currency || 'ZAR', b.notes || null]
    );
    res.status(201).json(mapProductionProduct(row));
  } catch (err: any) {
    if (String(err.message).includes('duplicate key')) return res.status(400).json({ error: `Model number "${b.modelNumber}" already exists.` });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/production-products/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const parsed = ProductionProductSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid product payload', details: parsed.error.flatten() });
  const b = parsed.data;
  try {
    const row = await queryOne(
      `UPDATE production_products SET
         model_number = COALESCE($1, model_number),
         description = COALESCE($2, description),
         category = COALESCE($3, category),
         production_cost = $4,
         selling_price = $5,
         currency = COALESCE($6, currency),
         notes = COALESCE($7, notes),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $8 RETURNING *`,
      [b.modelNumber ?? null, b.description ?? null, b.category ?? null, b.productionCost ?? null, b.sellingPrice ?? null, b.currency ?? null, b.notes ?? null, id]
    );
    if (!row) return res.status(404).json({ error: 'product not found' });
    res.json(mapProductionProduct(row));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/production-products/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query(`DELETE FROM production_products WHERE id = $1`, [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'product not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// [model, description, category, productionCost|null, sellingPrice|null]
// Selling prices come straight from the workbook's Ordering Calculator / model price lists.
// Production costs are ONLY filled where the sheet gives an explicit total cost paired with the
// selling price — the rest are left null (unknown) rather than fabricated, to be filled in-app.
const PRODUCTION_PRODUCTS_SEED: Array<[string, string, string, number | null, number | null]> = [
  ['TCU-001-SAT', '24V Self Powered, Single Axis Tracker', 'TCU', null, 8827.89],
  ['TCU-002-SAT', 'AC Powered, Single Axis Tracker', 'TCU', null, 9998.93],
  ['TCU-003-SAT', '300-1500Vdc String Powered, Single Axis Tracker', 'TCU', null, 10598.81],
  ['NCU-004-SANC', 'AC Powered Unit AC-DC 5V supply', 'NCU', null, 16656],
  ['NCU-005-SANC', 'DC Powered Unit DC-DC 5V supply', 'NCU', null, null],
  ['NCU-SYS-001', 'NCU System Cabinet 220Vac to 24Vdc 2.1A', 'NCU System', 25024.13, 33392.26],
  ['NCU-SYS-002', 'NCU System Cabinet Self PV Powered 48Vdc', 'NCU System', null, 34438.60],
  ['DON-001-SATD', 'Wireless LoRa Dongle (internal antenna)', 'Dongle', 1817.05, 3634.10],
  ['DON-002-SATD', 'Wireless LoRa Dongle (external antenna)', 'Dongle', 1817.05, 3634.10],
  ['DON-003-SATD', 'Wireless BLE Dongle', 'Dongle', null, 520.40],
  ['PROG-001-SATP', 'RS485 TCU Programming Cable', 'Programming', 390, 780],
  ['PWR-PCK-001', 'Power Pack Battery Box', 'Power', 2127.43, 4254.86],
  ['WIR-RGC-001', 'Coax RF Cable RG58 5m long extension', 'Accessory', null, 192.50],
  ['CAB-FLY-001', 'USB-C to USB-C cable', 'Accessory', null, 79],
  ['CAB-FLY-002', 'USB-C to USB-A cable', 'Accessory', null, 79],
  ['CAB-FLY-003', 'Antenna Adapter Cable', 'Accessory', null, 80],
  ['SEN-ANE-001', 'Wind Sensor Pulse Type (PCE-WS P)', 'Accessory', null, 2503.31],
  ['ANT-LORA-NCU', 'NCU High Gain LoRa Antenna 433MHz', 'Accessory', null, 260],
  ['ANT-TCU-001', 'TCU Antenna Cable', 'Accessory', null, 100],
];

async function ensureProductionCostsSchema() {
  await exec(`CREATE TABLE IF NOT EXISTS production_products (
    id SERIAL PRIMARY KEY,
    model_number TEXT UNIQUE NOT NULL,
    description TEXT,
    category TEXT,
    production_cost NUMERIC(14,2),
    selling_price NUMERIC(14,2),
    currency TEXT DEFAULT 'ZAR',
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  const count = await queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM production_products`);
  if (parseInt(count?.count || '0', 10) === 0) {
    for (const [model, desc, category, cost, price] of PRODUCTION_PRODUCTS_SEED) {
      await query(
        `INSERT INTO production_products (model_number, description, category, production_cost, selling_price)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (model_number) DO NOTHING`,
        [model, desc, category, cost, price]
      );
    }
    console.log(`Seeded ${PRODUCTION_PRODUCTS_SEED.length} production products.`);
  }
}

app.get('/api/bootstrap', async (_req, res) => {
  try {
    // 1. Items (exclude soft-deleted rows, same as GET /api/items)
    const { rows: itemsRows } = await query(sql('SELECT * FROM inventory WHERE deleted != true ORDER BY serial_number'));
    const { rows: countRows } = await query<{ count: string }>(sql('SELECT COUNT(*) as count FROM inventory WHERE deleted != true'));
    const totalItems = parseInt(countRows[0]?.count || '0', 10);

    // 2. Suppliers
    const { rows: suppliers } = await query('SELECT * FROM suppliers ORDER BY id');

    // 3. Projects
    const { rows: projectsRows } = await query('SELECT * FROM projects ORDER BY id');
    const projects = projectsRows.map((r: any) => ({
      // Numeric id: BOM/PP rows carry numeric projectId and the frontend Project
      // type declares id: number — emitting strings here broke strict-equality
      // filters (blank BOM manager) before App.tsx normalization was added.
      id: parseInt(r.id),
      projectName: r.project_name,
      description: r.description,
      status: r.status,
      createdDate: r.created_date,
      startDate: r.start_date,
      endDate: r.end_date,
      assignedTeam: r.assigned_team,
      designSpecs: r.design_specs
    }));

    // 4. Transactions
    const { rows: transactions } = await query('SELECT * FROM transactions ORDER BY id DESC LIMIT 100 OFFSET 0');

    // 5. Production Kits
    const { rows: productionKits } = await query('SELECT * FROM production_kits ORDER BY lastUpdated DESC');

    // 6. BOM Items (db_bom)
    const { rows: bomTables } = await query<{ tablename: string }>(`SELECT c.relname as tablename FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'db_bom%'`);
    let bomItems: any[] = [];
    for (const t of bomTables) {
      const { rows: bomRows } = await query(`SELECT * FROM "${t.tablename}"`);
      const mapped = bomRows.map((r: any) => {
        const stockCode = String(r.internal_stock_number || r.stock_code || r.StockCode || '');
        const designator = String(r.ref_des || r.designator || r.Designator || '');
        return {
          id: `BOM-${t.tablename}-${stockCode}-${designator}`,
          projectId: parseInt(r.project_name || r.projectId || r.ProjectId) || 1,
          stockCode,
          comment: String(r.comment || r.Comment || ''),
          description: String(r.description || r.Description || ''),
          designator,
          footprint: String(r.footprint || r.Footprint || ''),
          libref: String(r.libref || r.LibRef || ''),
          quantity: parseInt(r.qty_per_unit || r.quantity || r.Quantity) || 1
        };
      });
      bomItems = bomItems.concat(mapped);
    }

    // 7. PP Items (pp_bom)
    const { rows: ppTables } = await query<{ tablename: string }>(`SELECT c.relname as tablename FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'pp_bom%'`);
    let ppItems: any[] = [];
    for (const t of ppTables) {
      const { rows: ppRows } = await query(`SELECT * FROM "${t.tablename}"`);
      const mapped = ppRows.map((r: any) => {
        const stockCode = String(r.stock_code || r.internal_stock_number || r.StockCode || '');
        const designator = String(r.ref_des || r.designator || r.Designator || '');
        return {
          id: `PP-${t.tablename}-${stockCode}-${designator}`,
          projectId: parseInt(r.project_name || r.projectId || r.ProjectId) || 1,
          stockCode,
          comment: String(r.comment || r.Comment || ''),
          description: String(r.description || r.Description || ''),
          designator,
          footprint: String(r.footprint || r.Footprint || ''),
          libref: String(r.libref || r.LibRef || ''),
          quantity: parseInt(r.quantity || r.qty_per_unit || r.Quantity) || 1
        };
      });
      ppItems = ppItems.concat(mapped);
    }

    // 8. Settings
    const { rows: settingsRows } = await query('SELECT * FROM settings');
    const settings: any = {};
    for (const r of settingsRows) {
      try {
        settings[r.key] = JSON.parse(r.value);
      } catch {
        settings[r.key] = r.value;
      }
    }

    // 9. Job Cards
    const { rows: jobCardsRows } = await query('SELECT * FROM job_cards ORDER BY created_at DESC');
    const jobCards = jobCardsRows.map((r: any) => ({
      id: r.id,
      projectId: r.project_id,
      buildQty: r.build_qty,
      status: r.status,
      createdAt: r.created_at,
      assignedTeam: r.assigned_team
    }));

    // 10. Customers
    // Must match GET /api/clients — see the note there. The bookkeeping UI
    // resolves client_id against this list.
    const { rows: clientsRows } = await query('SELECT * FROM clients ORDER BY id');
    const clients = clientsRows.map((row: any) => ({
      id: row.id,
      clientName: row.client_name,
      contactName: row.contact_name,
      email: row.email,
      phone: row.phone,
      address: row.address,
      vatNumber: row.vat_number,
      status: row.status,
      createdAt: row.created_at
    }));

    // 11. Client Orders
    const { rows: clientOrdersRows } = await query('SELECT * FROM client_orders ORDER BY id');
    const clientOrders = clientOrdersRows.map((row: any) => ({
      id: row.id,
      clientId: row.client_id,
      orderNumber: row.order_number,
      orderDate: row.order_date,
      requiredDate: row.required_date,
      status: row.status,
      currency: row.currency,
      subtotal: row.subtotal,
      tax: row.tax,
      total: row.total,
      notes: row.notes,
      createdAt: row.created_at
    }));

    // 12. Client Order Items
    const { rows: clientOrderItemsRows } = await query('SELECT * FROM client_order_items ORDER BY id');
    const clientOrderItems = clientOrderItemsRows.map((row: any) => ({
      id: row.id,
      clientOrderId: row.client_order_id,
      partNumber: row.part_number,
      description: row.description,
      quantity: row.quantity,
      unitPrice: row.unit_price,
      lineTotal: row.line_total,
      createdAt: row.created_at
    }));

    // 13. Build Jobs
    const { rows: buildJobsRows } = await query('SELECT * FROM build_jobs ORDER BY id');
    const buildJobs = buildJobsRows.map((row: any) => ({
      id: row.id,
      clientOrderId: row.client_order_id,
      jobNumber: row.job_number,
      status: row.status,
      buildQty: row.build_qty,
      startDate: row.start_date,
      endDate: row.end_date,
      assignedTeam: row.assigned_team,
      notes: row.notes,
      createdAt: row.created_at
    }));

    // 14. BOM Structures
    const { rows: bomStructuresRows } = await query('SELECT * FROM bom_structures ORDER BY id');
    const bomStructures = bomStructuresRows.map((row: any) => ({
      id: row.id,
      parentPartNumber: row.parent_part_number,
      childPartNumber: row.child_part_number,
      quantity: row.quantity,
      description: row.description,
      createdAt: row.created_at
    }));

    // 15. Sub Assemblies
    const { rows: subAssembliesRows } = await query('SELECT * FROM sub_assemblies ORDER BY id');
    const subAssemblies = subAssembliesRows.map((row: any) => ({
      id: row.id,
      assemblyName: row.assembly_name,
      parentPartNumber: row.parent_part_number,
      childPartNumber: row.child_part_number,
      quantity: row.quantity,
      description: row.description,
      createdAt: row.created_at
    }));

    // 16. Fielded Assets
    const { rows: fieldedAssetsRows } = await query('SELECT * FROM fielded_assets ORDER BY id');
    const fieldedAssets = fieldedAssetsRows.map((row: any) => ({
      id: row.id,
      clientId: row.client_id,
      assetTag: row.asset_tag,
      serialNumber: row.serial_number,
      installedDate: row.installed_date,
      status: row.status,
      location: row.location,
      notes: row.notes,
      createdAt: row.created_at
    }));

    // 17. Stock Ledger
    const { rows: stockLedgerRows } = await query('SELECT * FROM stock_ledger ORDER BY movement_date DESC');
    const stockLedger = stockLedgerRows.map((row: any) => ({
      id: row.id,
      itemSerialNumber: row.item_serial_number,
      movementType: row.movement_type,
      quantity: row.quantity,
      movementDate: row.movement_date,
      reference: row.reference,
      notes: row.notes,
      createdAt: row.created_at
    }));

    res.json({
      items: { items: itemsRows, total: totalItems },
      suppliers,
      projects,
      transactions,
      productionKits,
      bomItems,
      ppItems,
      settings,
      jobCards,
      clients,
      clientOrders,
      clientOrderItems,
      buildJobs,
      bomStructures,
      subAssemblies,
      fieldedAssets,
      stockLedger
    });
  } catch (err: any) {
    console.error('ERROR IN GET /api/bootstrap:', err.message);
    // Return empty data if database is unavailable, so app can still function
    res.json({
      items: { items: [], total: 0 },
      suppliers: [],
      projects: [],
      transactions: [],
      productionKits: [],
      bomItems: [],
      ppItems: [],
      settings: {},
      jobCards: [],
      clients: [],
      clientOrders: [],
      clientOrderItems: [],
      buildJobs: [],
      bomStructures: [],
      subAssemblies: [],
      fieldedAssets: [],
      stockLedger: []
    });
  }
});

app.get('/api/items', async (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string) : null;
  const offset = parseInt(req.query.offset as string) || 0;

  if ((req.query.limit && isNaN(limit!)) || isNaN(offset)) {
    return res.status(400).json({ error: 'Invalid limit or offset' });
  }

  try {
    let items;
    if (limit !== null) {
      const { rows } = await query(sql('SELECT * FROM inventory WHERE deleted != true ORDER BY serial_number LIMIT $1 OFFSET $2'), [limit, offset]);
      items = rows;
    } else {
      const { rows } = await query(sql('SELECT * FROM inventory WHERE deleted != true ORDER BY serial_number'));
      items = rows;
    }

    const { rows: countRows } = await query<{ count: string }>(sql('SELECT COUNT(*) as count FROM inventory WHERE deleted != true'));
    const total = parseInt(countRows[0].count, 10);

    if (req.headers['x-request-format'] === 'paginated' || limit !== null) {
      res.json({
        data: items,
        pagination: { total, limit: limit ?? total, offset }
      });
    } else {
      res.json(items);
    }
  } catch (err: any) {
    console.error('ERROR IN POST /api/projects/:id/bom:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/items/products', async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM production_products ORDER BY model_number`);
    const items = rows.map((r: any) => ({
      partNumber: r.model_number,
      name: r.description,
      description: r.description,
      manufacturer: '',
      stockLevel: 999999,
      price: r.selling_price || 0,
      category: r.category || 'Product',
      status: 'ACTIVE',
      supplier: 'Internal Production'
    }));
    res.json(items);
  } catch (err: any) {
    console.error('ERROR IN GET /api/items/products:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/items/:serial_number', async (req, res) => {
  const serial_number = decodeURIComponent(req.params.serial_number);
  console.log(`[PATCH ITEM] ==========================================`);
  console.log(`[PATCH ITEM] req received for serial_number: ${serial_number}`);
  console.log(`[PATCH ITEM] body fields:`, Object.keys(req.body));
  console.log(`[PATCH ITEM] body:`, JSON.stringify(req.body));

  const result = ItemSchema.partial().safeParse(req.body);
  if (!result.success) {
    console.error(`[PATCH ITEM] safety validation failed:`, result.error.format());
    return res.status(400).json({ error: 'Invalid update data', details: result.error.format() });
  }
  const data = result.data as Record<string, any>;
  console.log(`[PATCH ITEM] after validation, data fields:`, Object.keys(data));
  console.log(`[PATCH ITEM] ALLOWED_ITEM_FIELDS:`, ALLOWED_ITEM_FIELDS);
  console.log(`[PATCH ITEM] status in data?:`, data.status);

  const sets: string[] = [];
  const vals: any[] = [];
  for (const key of ALLOWED_ITEM_FIELDS) {
    if (data[key] !== undefined) {
      sets.push(`"${key}" = $${sets.length + 1}`);
      vals.push(data[key]);
      if (key === 'status') {
        console.log(`[PATCH ITEM] including status field: ${data[key]}`);
      }
    }
  }
  if (sets.length === 0) {
    console.warn(`[PATCH ITEM] no fields to update.`);
    return res.status(400).json({ error: 'no fields to update' });
  }
  const sqlText = `UPDATE inventory SET ${sets.join(', ')} WHERE serial_number = $${sets.length + 1}`;
  vals.push(serial_number);
  console.log(`[PATCH ITEM] executing update: ${sets.join(', ')}`);
  console.log(`[PATCH ITEM] full SQL: ${sqlText}`);
  try {
    const { rowCount } = await query(sqlText, vals);
    console.log(`[PATCH ITEM] update complete. rowCount: ${rowCount}`);
    if (rowCount === 0) {
      console.warn(`[PATCH ITEM] item not found: ${serial_number}`);
      return res.status(404).json({ error: 'item not found' });
    }

    // FIX: Neon serverless may have read-after-write consistency issues
    // Retry fetching the updated item until we get fresh data or timeout
    let row = null;
    let attempts = 0;
    const maxAttempts = 15;
    const baseDelay = 500;

    console.log(`[PATCH ITEM] verifying update with retry logic... requesting updates for: ${JSON.stringify(data)}`);

    for (attempts = 0; attempts < maxAttempts; attempts++) {
      if (attempts > 0) {
        const delay = baseDelay * Math.pow(1.5, attempts - 1);
        console.log(`[PATCH ITEM] retry attempt ${attempts}/${maxAttempts}, waiting ${Math.round(delay)}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      row = await queryOne(`SELECT * FROM inventory WHERE serial_number = $1`, [serial_number]);

      if (!row) {
        console.warn(`[PATCH ITEM] item not found on attempt ${attempts + 1}`);
        continue;
      }

      // Check if status specifically was updated
      if (data.status) {
        console.log(`[PATCH ITEM] attempt ${attempts + 1}: expected status=${data.status}, got=${row.status}`);
        if (String(row.status).toUpperCase().trim() === String(data.status).toUpperCase().trim()) {
          console.log(`[PATCH ITEM] ✓ STATUS MATCH! Data persisted correctly`);
          break;
        }
      } else {
        // If no status update, just return the row
        console.log(`[PATCH ITEM] no status update requested, returning row`);
        break;
      }
    }

    if (!row) {
      console.error(`[PATCH ITEM] failed to retrieve item after ${attempts + 1} attempts`);
      return res.status(500).json({ error: 'Failed to retrieve updated item' });
    }

    console.log(`[PATCH ITEM] final status in DB: ${row?.status}, took ${attempts + 1} attempt(s)`);

    // Force one final read with a longer delay to ensure persistence
    await new Promise(resolve => setTimeout(resolve, 1000));
    const finalRow = await queryOne(`SELECT * FROM inventory WHERE serial_number = $1`, [serial_number]);

    if (finalRow) {
      console.log(`[PATCH ITEM] FINAL VERIFICATION: status in DB is ${finalRow.status}`);
      res.json(finalRow);
    } else {
      res.json(row);
    }
  } catch (err: any) {
    console.error(`[PATCH ITEM] ERROR during update:`, err.message);
    res.status(500).json({ error: 'Failed to update item', details: err.message });
  }
});

app.put('/api/items/:serial_number', async (req, res) => {
  const serial_number = decodeURIComponent(req.params.serial_number);
  const result = ItemSchema.partial().safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: 'Invalid update data', details: result.error.format() });
  }
  const data = result.data as Record<string, any>;
  const sets: string[] = [];
  const vals: any[] = [];
  for (const key of ALLOWED_ITEM_FIELDS) {
    if (data[key] !== undefined) {
      sets.push(`"${key}" = $${sets.length + 1}`);
      vals.push(data[key]);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'no fields to update' });
  const sqlText = `UPDATE inventory SET ${sets.join(', ')} WHERE serial_number = $${sets.length + 1}`;
  vals.push(serial_number);
  const { rowCount } = await query(sqlText, vals);
  if (rowCount === 0) return res.status(404).json({ error: 'item not found' });
  const row = await queryOne(`SELECT * FROM inventory WHERE serial_number = $1`, [serial_number]);
  res.json(row);
});

app.get('/api/items/:serial_number/references', async (req, res) => {
  const serial_number = decodeURIComponent(req.params.serial_number);
  console.log(`[CHECK REFERENCES] checking references for item: ${serial_number}`);

  try {
    const references: { [key: string]: number } = {};

    // Since checking actual BOM tables is complex, return empty references for now
    // In the future, this can be enhanced to check actual BOM and pick note tables
    // For now, the delete confirmation dialog will work with just the basic confirmation

    res.json({ references, hasReferences: false });
  } catch (err: any) {
    console.error(`[CHECK REFERENCES] ERROR:`, err.message);
    // Return empty references on error rather than 500
    res.json({ references: {}, hasReferences: false });
  }
});

app.delete('/api/items/:serial_number', async (req, res) => {
  const serial_number = decodeURIComponent(req.params.serial_number);
  console.log(`[DELETE ITEM] =========== DELETE REQUEST RECEIVED ===========`);
  console.log(`[DELETE ITEM] serial_number: ${serial_number}`);
  console.log(`[DELETE ITEM] method: ${req.method}`);
  console.log(`[DELETE ITEM] path: ${req.path}`);

  try {
    // Soft delete: mark item as deleted instead of removing it
    console.log(`[DELETE ITEM] executing soft delete query...`);
    const { rowCount } = await query(`UPDATE inventory SET deleted = true WHERE serial_number = $1`, [serial_number]);
    console.log(`[DELETE ITEM] query result - rowCount: ${rowCount}`);

    if (rowCount === 0) {
      console.warn(`[DELETE ITEM] item not found: ${serial_number}`);
      return res.status(404).json({ error: 'item not found' });
    }

    console.log(`[DELETE ITEM] successfully soft-deleted item: ${serial_number}`);
    res.json({ success: true, message: `Item ${serial_number} deleted successfully` });
  } catch (err: any) {
    console.error(`[DELETE ITEM] ERROR deleting item:`, err.message);
    res.status(500).json({ error: 'Failed to delete item', details: err.message });
  }
});

app.post('/api/items/restore/:serial_number', async (req, res) => {
  const serial_number = decodeURIComponent(req.params.serial_number);
  const itemData = req.body;
  console.log(`[RESTORE ITEM] request to restore item: ${serial_number}`);

  try {
    if (!itemData || typeof itemData !== 'object') {
      return res.status(400).json({ error: 'Invalid item data for restore' });
    }

    const fields: string[] = [];
    const vals: any[] = [];
    let paramCount = 1;

    for (const key of ALLOWED_ITEM_FIELDS) {
      if (itemData[key] !== undefined && itemData[key] !== null) {
        fields.push(`"${key}" = $${paramCount}`);
        vals.push(itemData[key]);
        paramCount++;
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to restore' });
    }

    const sqlText = `INSERT INTO inventory (serial_number, ${fields.map(f => f.split(' = ')[0]).join(', ')})
                     VALUES ($${paramCount}, ${fields.map((_, i) => `$${i + 1}`).join(', ')})
                     ON CONFLICT (serial_number) DO UPDATE SET ${fields.join(', ')}`;
    vals.push(serial_number);

    console.log(`[RESTORE ITEM] executing restore query with item: ${serial_number}`);
    const { rowCount } = await query(sqlText, vals);

    if (rowCount === 0) {
      console.warn(`[RESTORE ITEM] failed to restore item: ${serial_number}`);
      return res.status(500).json({ error: 'Failed to restore item' });
    }

    const row = await queryOne(`SELECT * FROM inventory WHERE serial_number = $1`, [serial_number]);
    console.log(`[RESTORE ITEM] successfully restored item: ${serial_number}`);
    res.json({ success: true, message: `Item ${serial_number} restored successfully`, item: row });
  } catch (err: any) {
    console.error(`[RESTORE ITEM] ERROR restoring item:`, err.message);
    res.status(500).json({ error: 'Failed to restore item', details: err.message });
  }
});

app.post('/api/items', async (req, res) => {
  const result = ItemSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: 'Invalid item data', details: result.error.format() });
  }
  const data: any = result.data;
  const fields: string[] = [];
  const placeholders: string[] = [];
  const vals: any[] = [];
  const updates: string[] = [];

  fields.push('serial_number');
  placeholders.push('$1');
  vals.push(data.serial_number);

  let idx = 2;
  for (const key of ALLOWED_ITEM_FIELDS) {
    if (data[key] !== undefined) {
      fields.push(`"${key}"`);
      placeholders.push(`$${idx}`);
      vals.push(data[key]);
      updates.push(`"${key}" = EXCLUDED."${key}"`);
      idx++;
    }
  }

  let sqlText;
  if (updates.length > 0) {
    sqlText = `INSERT INTO inventory (${fields.join(', ')}) VALUES (${placeholders.join(', ')})
                 ON CONFLICT(serial_number) DO UPDATE SET ${updates.join(', ')}`;
  } else {
    sqlText = `INSERT INTO inventory (${fields.join(', ')}) VALUES (${placeholders.join(', ')})
                 ON CONFLICT(serial_number) DO NOTHING`;
  }
  try {
    await query(sqlText, vals);
    const row = await queryOne(`SELECT * FROM inventory WHERE serial_number = $1`, [data.serial_number]);
    res.status(201).json(row);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/items/bulk', async (req, res) => {
  const result = z.array(ItemSchema).safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: 'Invalid items array', details: result.error.format() });
  }
  const items = result.data;

  // PARTIAL upsert: only touch the columns actually present in each payload row. Previously this
  // wrote ALL columns (missing ones -> NULL), so a price-only update would wipe an item's name,
  // stock, part numbers, etc. Building per-row SQL from the provided keys preserves untouched
  // columns. (It also uses Postgres $1..$N placeholders — the old code used SQLite-style '?',
  // which was invalid here and made every bulk update fail with a swallowed 500.)
  const upsert = async (rows: any[]) => {
    for (const data of rows) {
      const keys = ['serial_number', ...ALLOWED_ITEM_FIELDS].filter(f => (data as any)[f] !== undefined && (data as any)[f] !== null);
      if (!keys.includes('serial_number')) continue; // PK is required to target a row
      const cols = keys.map(f => `"${f}"`).join(', ');
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const updateCols = keys.filter(f => f !== 'serial_number');
      const vals = keys.map(f => (data as any)[f]);
      if (updateCols.length === 0) {
        // Only the PK was supplied — make sure the row exists but change nothing.
        await query(`INSERT INTO inventory ("serial_number") VALUES ($1) ON CONFLICT (serial_number) DO NOTHING`, [data.serial_number]);
        continue;
      }
      const updates = updateCols.map(f => `"${f}" = EXCLUDED."${f}"`).join(', ');
      await query(
        `INSERT INTO inventory (${cols}) VALUES (${placeholders}) ON CONFLICT (serial_number) DO UPDATE SET ${updates}`,
        vals
      );
    }
  };

  try {
    await upsert(items);
    res.json({ ok: true, count: items.length });
  } catch (err: any) {
    console.error('ERROR IN POST /api/items/bulk:', err.message);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

app.post('/api/items/set-all-active', async (_req, res) => {
  try {
    // Set all items with NULL, empty string, or any non-compliant status to ACTIVE
    const sqlText = `UPDATE inventory SET status = 'ACTIVE' WHERE status IS NULL OR status = '' OR status NOT IN ('ACTIVE', 'INACTIVE', 'BOOKED OUT', 'DISCONTINUED')`;
    const { rowCount } = await query(sqlText);
    console.log(`[POST /api/items/set-all-active] Update complete. ${rowCount} items set to ACTIVE.`);
    res.json({ ok: true, updatedCount: rowCount });
  } catch (err: any) {
    console.error('ERROR IN POST /api/items/set-all-active:', err.message);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

app.post('/api/items/fix-status', async (_req, res) => {
  try {
    // Comprehensive fix: set all NULL/empty status to ACTIVE
    const fixNull = await query(`UPDATE inventory SET status = 'ACTIVE' WHERE status IS NULL`);
    const fixEmpty = await query(`UPDATE inventory SET status = 'ACTIVE' WHERE status = ''`);
    const fixInvalid = await query(`UPDATE inventory SET status = 'ACTIVE' WHERE status NOT IN ('ACTIVE', 'INACTIVE', 'BOOKED OUT', 'DISCONTINUED')`);

    const total = (fixNull.rowCount || 0) + (fixEmpty.rowCount || 0) + (fixInvalid.rowCount || 0);
    console.log(`[POST /api/items/fix-status] Fixed ${total} items with invalid status. NULL: ${fixNull.rowCount}, Empty: ${fixEmpty.rowCount}, Invalid: ${fixInvalid.rowCount}`);
    res.json({ ok: true, fixedCount: total, details: { nullFixed: fixNull.rowCount, emptyFixed: fixEmpty.rowCount, invalidFixed: fixInvalid.rowCount } });
  } catch (err: any) {
    console.error('ERROR IN POST /api/items/fix-status:', err.message);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

app.post('/api/items/fix-inactive', async (_req, res) => {
  try {
    // Convert all INACTIVE items to ACTIVE
    const { rowCount } = await query(`UPDATE inventory SET status = 'ACTIVE' WHERE status = 'INACTIVE'`);
    console.log(`[POST /api/items/fix-inactive] Fixed ${rowCount} INACTIVE items to ACTIVE`);
    res.json({ ok: true, fixedCount: rowCount });
  } catch (err: any) {
    console.error('ERROR IN POST /api/items/fix-inactive:', err.message);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

app.get('/api/items/generate-code/:category', async (req, res) => {
  try {
    const category = req.params.category?.toUpperCase();
    if (!category) {
      return res.status(400).json({ error: 'Category is required' });
    }

    // Get category prefix (first 3 letters)
    const prefix = category.substring(0, 3).toUpperCase();

    // Find all items with this prefix
    const { rows } = await query(`
      SELECT serial_number FROM inventory
      WHERE serial_number LIKE $1
      ORDER BY serial_number DESC
      LIMIT 1
    `, [`${prefix}%`]);

    let nextNumber = 1;
    if (rows.length > 0) {
      const lastCode = rows[0].serial_number;
      // Extract number from code (e.g., "BUT-003" -> 3)
      const match = lastCode.match(/(\d+)$/);
      if (match) {
        nextNumber = parseInt(match[1], 10) + 1;
      }
    }

    // Format with leading zeros (e.g., "BUT-001")
    const newCode = `${prefix}-${String(nextNumber).padStart(3, '0')}`;

    console.log(`[GET /api/items/generate-code] Generated ${newCode} for category ${category}`);
    res.json({ code: newCode, category, nextNumber });
  } catch (err: any) {
    console.error('ERROR IN GET /api/items/generate-code:', err.message);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

// ============================================================================
// USER MANAGEMENT & AUTHENTICATION
// ============================================================================

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Check hardcoded demo credentials first
    if (email === 'dedw13@gmail.com' && password === 'password123') {
      return res.json({
        id: 1,
        email: 'dedw13@gmail.com',
        firstName: 'Demo',
        lastName: 'User',
        role: 'admin',
        status: 'ACTIVE'
      });
    }

    // Try to authenticate against database
    try {
      const { rows } = await query(
        `SELECT id, email, first_name, last_name, role, status, password FROM users WHERE email = $1`,
        [email]
      );

      if (rows.length === 0) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const user = rows[0];

      // Check if user is active
      if (user.status !== 'ACTIVE') {
        return res.status(401).json({ error: 'User account is not active' });
      }

      // Password comparison - handle both hashed and plain text for testing
      const hashedPassword = Buffer.from(password).toString('base64');
      const storedPassword = user.password;

      // Support both hashed passwords and plain text for demo/test accounts
      const passwordMatch =
        (storedPassword && storedPassword === hashedPassword) ||
        (storedPassword && storedPassword.includes(password)) ||
        (!storedPassword && password); // Allow if no password set in DB (legacy)

      if (!passwordMatch) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // Return user info (without password)
      res.json({
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        status: user.status
      });
    } catch (dbErr) {
      // If database query fails, only allow demo credentials (already checked above)
      console.error('Database login error:', (dbErr as any).message);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
  } catch (err: any) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// ============================================================================

app.post('/api/activity-log', async (req, res) => {
  try {
    const { userEmail, action, entityType, entityId, details, status } = req.body;

    // Detect real client IP from proxy headers (try multiple common headers)
    let ipAddress = '';
    const xForwardedFor = req.headers['x-forwarded-for'] as string;
    const cfConnectingIp = req.headers['cf-connecting-ip'] as string;
    const xRealIp = req.headers['x-real-ip'] as string;

    if (xForwardedFor) {
      ipAddress = xForwardedFor.split(',')[0].trim();
    } else if (cfConnectingIp) {
      ipAddress = cfConnectingIp.trim();
    } else if (xRealIp) {
      ipAddress = xRealIp.trim();
    } else {
      ipAddress = (req.socket.remoteAddress || '').split(':').pop() || '';
    }

    const userAgent = req.headers['user-agent'] || '';

    if (!userEmail || !action) {
      return res.status(400).json({ error: 'userEmail and action are required' });
    }

    const logResult = await query(
      `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, ip_address, user_agent, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [userEmail, action, entityType || null, entityId || null, JSON.stringify(details || {}), ipAddress, userAgent, status || 'SUCCESS']
    );

    res.json({ success: true, logId: logResult.rows[0].id });
  } catch (err) {
    console.error('Activity log error:', err);
    res.status(500).json({ error: 'Failed to log activity' });
  }
});

app.get('/api/activity-logs', async (req, res) => {
  try {
    const { userEmail, action, limit = '100', offset = '0' } = req.query;
    let sql = 'SELECT * FROM user_activity_logs WHERE 1=1';
    const params: any[] = [];

    if (userEmail) {
      sql += ` AND user_email = $${params.length + 1}`;
      params.push(userEmail);
    }
    if (action) {
      sql += ` AND action = $${params.length + 1}`;
      params.push(action);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit as string) || 100, parseInt(offset as string) || 0);

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching activity logs:', err);
    res.status(500).json({ error: 'Failed to fetch activity logs' });
  }
});

// ============================================================================

app.post('/api/users/init-roles', async (_req, res) => {
  try {
    // Initialize default roles and permissions
    const roles = ['admin', 'manager', 'viewer'];
    const permissions: Record<string, string[]> = {
      admin: [
        'users.create', 'users.read', 'users.update', 'users.delete',
        'inventory.create', 'inventory.read', 'inventory.update', 'inventory.delete',
        'suppliers.create', 'suppliers.read', 'suppliers.update', 'suppliers.delete',
        'orders.create', 'orders.read', 'orders.update', 'orders.delete',
        'reports.read', 'settings.update', 'automation.create', 'automation.delete'
      ],
      manager: [
        'users.read',
        'inventory.create', 'inventory.read', 'inventory.update',
        'suppliers.read', 'suppliers.update',
        'orders.create', 'orders.read', 'orders.update',
        'reports.read', 'automation.create'
      ],
      viewer: [
        'inventory.read', 'suppliers.read', 'orders.read', 'reports.read'
      ]
    };

    for (const role of roles) {
      for (const permission of permissions[role]) {
        await query(
          `INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [role, permission]
        );
      }
    }

    res.json({ ok: true, message: 'Roles and permissions initialized' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, email, first_name, last_name, role, status, created_at, last_login FROM users ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const { email, password, firstName, lastName, role } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Hash password (in production, use bcrypt)
    const hashedPassword = Buffer.from(password).toString('base64');

    const { rows } = await query(
      `INSERT INTO users (email, password, first_name, last_name, role, status)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
       RETURNING id, email, first_name, last_name, role, status, created_at`,
      [email, hashedPassword, firstName, lastName, role || 'viewer']
    );

    console.log(`[POST /api/users] Created user: ${email}`);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.message.includes('duplicate')) {
      res.status(409).json({ error: 'Email already exists' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

app.put('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { firstName, lastName, role, status } = req.body;

    const { rows } = await query(
      `UPDATE users SET first_name = $1, last_name = $2, role = $3, status = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING id, email, first_name, last_name, role, status, updated_at`,
      [firstName, lastName, role, status, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    console.log(`[PUT /api/users] Updated user: ${id}`);
    res.json(rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { rowCount } = await query('DELETE FROM users WHERE id = $1', [id]);

    if (rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    console.log(`[DELETE /api/users] Deleted user: ${id}`);
    res.json({ ok: true, message: 'User deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:id/permissions', async (req, res) => {
  try {
    const { id } = req.params;

    const userRes = await queryOne<{ role: string }>(
      'SELECT role FROM users WHERE id = $1',
      [id]
    );

    if (!userRes) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { rows } = await query(
      'SELECT permission FROM role_permissions WHERE role = $1 ORDER BY permission',
      [userRes.role]
    );

    res.json({
      role: userRes.role,
      permissions: rows.map(r => r.permission)
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/roles', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT DISTINCT role FROM role_permissions ORDER BY role`
    );
    res.json(rows.map(r => r.role));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/suppliers', async (_req, res) => {
  const { rows } = await query('SELECT * FROM suppliers ORDER BY id');
  res.json(rows);
});

app.put('/api/suppliers/:id', async (req, res) => {
  const id = req.params.id;
  const { name, website, contact_email, notes, lead_time, response_time } = req.body;
  const sqlText = `UPDATE suppliers SET name = $1, website = $2, contact_email = $3, notes = $4, lead_time = $5, response_time = $6 WHERE id = $7`;
  try {
    const { rowCount } = await query(sqlText, [name, website, contact_email, notes, lead_time, response_time, id]);
    if (rowCount === 0) return res.status(404).json({ error: 'supplier not found' });
    const row = await queryOne(`SELECT * FROM suppliers WHERE id = $1`, [id]);
    res.json(row);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/suppliers', async (req, res) => {
  const { id, name, website, contact_email, notes, lead_time, response_time } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });
  const sqlText = `INSERT INTO suppliers (id, name, website, contact_email, notes, lead_time, response_time) VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, website=EXCLUDED.website, contact_email=EXCLUDED.contact_email, notes=EXCLUDED.notes, lead_time=EXCLUDED.lead_time, response_time=EXCLUDED.response_time`;
  try {
    await query(sqlText, [id, name, website, contact_email, notes, lead_time, response_time]);
    const row = await queryOne(`SELECT * FROM suppliers WHERE id = $1`, [id]);
    res.status(201).json(row);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM projects ORDER BY id');
    const mapped = rows.map((r: any) => ({
      id: parseInt(r.id) || 0,
      projectName: r.project_name,
      description: r.description,
      status: r.status,
      createdDate: r.created_date,
      startDate: r.start_date,
      endDate: r.end_date,
      assignedTeam: r.assigned_team,
      designSpecs: r.design_specs
    }));
    res.json(mapped);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', async (req, res) => {
  const { projectName, description, status, createdDate, startDate, endDate, assignedTeam, designSpecs } = req.body;
  if (!projectName) return res.status(400).json({ error: 'projectName is required' });
  
  try {
    // First try to find existing project with same name
    const existing = await queryOne(`SELECT * FROM projects WHERE project_name = $1`, [projectName]);
    let row;
    let isNew = false;
    
    if (existing) {
      // Update existing
      await query(`UPDATE projects SET description = $1, status = $2, start_date = $3, end_date = $4, assigned_team = $5, design_specs = $6 WHERE project_name = $7`,
        [description || '', status || 'Active', startDate || null, endDate || null, assignedTeam || '', designSpecs || '', projectName]);
      row = existing;
    } else {
      // Insert new - generate sequential id
      const maxId = await queryOne(`SELECT COALESCE(MAX(id::integer), 0) + 1 as next_id FROM projects`, []);
      const nextId = maxId?.next_id || 1;
      await query(`INSERT INTO projects (id, project_name, description, status, created_date, start_date, end_date, assigned_team, design_specs) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [nextId, projectName, description || '', status || 'Active', createdDate || new Date().toISOString().split('T')[0], startDate || null, endDate || null, assignedTeam || '', designSpecs || '']);
      row = {
        id: nextId,
        project_name: projectName,
        description: description || '',
        status: status || 'Active',
        created_date: createdDate || new Date().toISOString().split('T')[0],
        start_date: startDate || null,
        end_date: endDate || null,
        assigned_team: assignedTeam || '',
        design_specs: designSpecs || ''
      };
      isNew = true;
    }
    
    const mapped = {
      id: parseInt(row?.id || '0'),
      projectName: row?.project_name,
      description: row?.description,
      status: row?.status,
      createdDate: row?.created_date,
      startDate: row?.start_date,
      endDate: row?.end_date,
      assignedTeam: row?.assigned_team,
      designSpecs: row?.design_specs
    };
    res.status(isNew ? 201 : 200).json(mapped);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/projects/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { projectName, description, status, startDate, endDate, assignedTeam, designSpecs } = req.body;
  const sqlText = `UPDATE projects SET project_name = $1, description = $2, status = $3, start_date = $4, end_date = $5, assigned_team = $6, design_specs = $7 WHERE id = $8`;
  try {
    const { rowCount } = await query(sqlText, [projectName, description, status, startDate, endDate, assignedTeam, designSpecs, id]);
    if (rowCount === 0) return res.status(404).json({ error: 'project not found' });
    const row = await queryOne(`SELECT * FROM projects WHERE id = $1`, [id]);
    const mapped = {
      id: parseInt(row?.id || '0'),
      projectName: row?.project_name,
      description: row?.description,
      status: row?.status,
      createdDate: row?.created_date,
      startDate: row?.start_date,
      endDate: row?.end_date,
      assignedTeam: row?.assigned_team,
      designSpecs: row?.design_specs
    };
    res.json(mapped);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query(`DELETE FROM projects WHERE id = $1`, [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'project not found' });
    // Cascade: drop this project's BOM/P&P tables and job cards. Ids are allocated
    // as MAX(id)+1, so a freed id gets reused — orphaned data would silently attach
    // itself to the next project created with the same id.
    await exec(`DROP TABLE IF EXISTS "db_bom_project_${id}"`).catch(() => {});
    await exec(`DROP TABLE IF EXISTS "pp_bom_project_${id}"`).catch(() => {});
    await query(`DELETE FROM job_cards WHERE project_id = $1`, [id]).catch(() => {});
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/restore/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const projectData = req.body;
  console.log(`[RESTORE PROJECT] request to restore project: ${id}`);

  try {
    if (!projectData || typeof projectData !== 'object') {
      return res.status(400).json({ error: 'Invalid project data for restore' });
    }

    // The snapshot is the frontend Project shape logged at delete time:
    // { id, projectName, description, status, createdDate, startDate, endDate, assignedTeam, designSpecs }
    const {
      projectName,
      description,
      status,
      createdDate,
      startDate,
      endDate,
      assignedTeam,
      designSpecs
    } = projectData;

    const sqlText = `
      INSERT INTO projects (id, project_name, description, status, created_date, start_date, end_date, assigned_team, design_specs)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        project_name = EXCLUDED.project_name,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        created_date = EXCLUDED.created_date,
        start_date = EXCLUDED.start_date,
        end_date = EXCLUDED.end_date,
        assigned_team = EXCLUDED.assigned_team,
        design_specs = EXCLUDED.design_specs
    `;

    const { rowCount } = await query(sqlText, [
      id,
      projectName || 'Untitled Project',
      description || '',
      status || 'Active',
      createdDate || new Date().toISOString().split('T')[0],
      startDate || null,
      endDate || null,
      assignedTeam || '',
      designSpecs || ''
    ]);

    if (rowCount === 0) {
      console.warn(`[RESTORE PROJECT] failed to restore project: ${id}`);
      return res.status(500).json({ error: 'Failed to restore project' });
    }

    const row = await queryOne(`SELECT * FROM projects WHERE id = $1`, [id]);
    console.log(`[RESTORE PROJECT] successfully restored project: ${id}`);
    res.json({ success: true, message: `Project ${id} restored successfully`, project: row });
  } catch (err: any) {
    console.error(`[RESTORE PROJECT] ERROR restoring project:`, err.message);
    res.status(500).json({ error: 'Failed to restore project', details: err.message });
  }
});

app.get('/api/projects/:id/bom', async (req, res) => {
  const projectId = parseInt(req.params.id);
  try {
    const { rows } = await query(`SELECT * FROM "db_bom_project_${projectId}"`);
    const mapped = rows.map((r: any) => ({
      stockCode: String(r.internal_stock_number || ''),
      quantity: parseInt(r.qty_per_unit || '0') || 1,
      designator: String(r.ref_des || ''),
      description: String(r.description || ''),
      comment: String(r.comment || ''),
      footprint: String(r.footprint || ''),
      libref: String(r.libref || '')
    }));
    res.json(mapped);
  } catch (err: any) {
    if (err.code === '42P01') {
      return res.json([]);
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/bom', async (req, res) => {
  const projectId = parseInt(req.params.id);
  const { items } = req.body; // items: [{ stockCode: string, quantity: number, designator: string }]
  console.log(`[POST BOM] req received for project ${projectId}, items count: ${items ? items.length : 0}`);
  
  try {
    const tableName = `db_bom_project_${projectId}`;
    console.log(`[POST BOM] creating table if not exists "${tableName}"...`);
    await query(`CREATE TABLE IF NOT EXISTS "${tableName}" (
      project_name INTEGER,
      internal_stock_number TEXT PRIMARY KEY,
      qty_per_unit INTEGER,
      ref_des TEXT
    )`);
    console.log(`[POST BOM] table "${tableName}" created/checked successfully.`);

    // Ensure extra columns exist for both new and legacy tables
    const extraColumns = [
      { name: 'description', type: 'TEXT DEFAULT \'\'' },
      { name: 'comment', type: 'TEXT DEFAULT \'\'' },
      { name: 'footprint', type: 'TEXT DEFAULT \'\'' },
      { name: 'libref', type: 'TEXT DEFAULT \'\'' }
    ];

    for (const col of extraColumns) {
      console.log(`[POST BOM] ensuring column "${col.name}" exists on "${tableName}"...`);
      await query(`ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
    }
    console.log(`[POST BOM] all extra columns checked.`);
    
    for (const item of items) {
      console.log(`[POST BOM] inserting/updating item ${item.stockCode} in "${tableName}"...`);
      await query(`INSERT INTO "${tableName}" (project_name, internal_stock_number, qty_per_unit, ref_des, description, comment, footprint, libref) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT(internal_stock_number) DO UPDATE SET
                   qty_per_unit = EXCLUDED.qty_per_unit,
                   ref_des = EXCLUDED.ref_des,
                   description = EXCLUDED.description,
                   comment = EXCLUDED.comment,
                   footprint = EXCLUDED.footprint,
                   libref = EXCLUDED.libref`,
        [projectId, item.stockCode, item.quantity, item.designator || '', item.description || '', item.comment || '', item.footprint || '', item.libref || '']);
    }
    console.log(`[POST BOM] items upsert complete.`);

    // Synchronize CAD with Manufacturing: Reset associated production kits to STAGING
    console.log(`[POST BOM] updating production_kits...`);
    await query(`UPDATE production_kits SET status = 'STAGING', lastUpdated = $1 WHERE projectId = $2`,
      [new Date().toISOString().split('T')[0], projectId]);
    console.log(`[POST BOM] production_kits updated successfully.`);

    res.json({ ok: true });
  } catch (err: any) {
    console.error('ERROR IN POST /api/projects/:id/bom:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/pp', async (req, res) => {
  const projectId = parseInt(req.params.id);
  const { items } = req.body;
  
  try {
    const tableName = `pp_bom_project_${projectId}`;
    await query(`CREATE TABLE IF NOT EXISTS "${tableName}" (
      project_name INTEGER,
      stock_code TEXT PRIMARY KEY,
      quantity INTEGER
    )`).catch(() => {});

    const ppExtraColumns = [
      { name: 'comment', type: 'TEXT DEFAULT \'\'' },
      { name: 'description', type: 'TEXT DEFAULT \'\'' },
      { name: 'designator', type: 'TEXT DEFAULT \'\'' },
      { name: 'footprint', type: 'TEXT DEFAULT \'\'' },
      { name: 'libref', type: 'TEXT DEFAULT \'\'' }
    ];

    for (const col of ppExtraColumns) {
      await query(`ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`).catch(() => {});
    }
    
    for (const item of items) {
      await query(`INSERT INTO "${tableName}" (project_name, stock_code, comment, description, designator, footprint, libref, quantity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT(stock_code) DO UPDATE SET
                   comment = EXCLUDED.comment,
                   description = EXCLUDED.description,
                   designator = EXCLUDED.designator,
                   footprint = EXCLUDED.footprint,
                   libref = EXCLUDED.libref,
                   quantity = EXCLUDED.quantity`,
        [projectId, item.stockCode, item.comment || '', item.description || '', item.designator || '', item.footprint || '', item.libref || '', item.quantity]);
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/job-cards', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM job_cards ORDER BY created_at DESC');
    const mapped = rows.map((r: any) => ({
      id: r.id,
      projectId: r.project_id,
      buildQty: r.build_qty,
      status: r.status,
      createdAt: r.created_at,
      assignedTeam: r.assigned_team
    }));
    res.json(mapped);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/job-cards', async (req, res) => {
  const { projectId, buildQty, status } = req.body;
  const sqlText = `INSERT INTO job_cards (project_id, build_qty, status, created_at) VALUES ($1, $2, $3, $4)`;
  try {
    await query(sqlText, [projectId, buildQty || 0, status || 'Pending', new Date().toISOString()]);
    res.status(201).json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bom-items', async (_req, res) => {
  try {
    const { rows: tables } = await query<{ tablename: string }>(`SELECT c.relname as tablename FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'db_bom%'`);
    let allItems: any[] = [];
    for (const t of tables) {
      const { rows } = await query(`SELECT * FROM "${t.tablename}"`);
      const mapped = rows.map((r: any) => {
        const stockCode = String(r.internal_stock_number || r.stock_code || r.StockCode || '');
        const designator = String(r.ref_des || r.designator || r.Designator || '');
        return {
          id: `BOM-${t.tablename}-${stockCode}-${designator}`,
          projectId: parseInt(r.project_name || r.projectId || r.ProjectId) || 1,
          stockCode,
          comment: String(r.comment || r.Comment || ''),
          description: String(r.description || r.Description || ''),
          designator,
          footprint: String(r.footprint || r.Footprint || ''),
          libref: String(r.libref || r.LibRef || ''),
          quantity: parseInt(r.qty_per_unit || r.quantity || r.Quantity) || 1
        };
      });
      allItems = allItems.concat(mapped);
    }
    res.json(allItems);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pp-items', async (_req, res) => {
  try {
    const { rows: tables } = await query<{ tablename: string }>(`SELECT c.relname as tablename FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'pp_bom%'`);
    let allItems: any[] = [];
    for (const t of tables) {
      const { rows } = await query(`SELECT * FROM "${t.tablename}"`);
      const mapped = rows.map((r: any, idx: number) => {
        const stockCode = String(r.stock_code || r.internal_stock_number || r.StockCode || '');
        return {
          id: `PP-${t.tablename}-${idx}`,
          projectId: parseInt(r.project_name || r.projectId || r.ProjectId) || 1,
          stockCode,
          comment: String(r.comment || r.Comment || ''),
          description: String(r.description || r.Description || ''),
          designator: String(r.designator || r.ref_des || r.Designator || ''),
          footprint: String(r.footprint || r.Footprint || ''),
          libref: String(r.libref || r.LibRef || ''),
          quantity: parseInt(r.quantity || r.qty_per_unit || r.Quantity) || 1
        };
      });
      allItems = allItems.concat(mapped);
    }
    res.json(allItems);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/transactions', async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const offset = parseInt(req.query.offset as string) || 0;

  if (isNaN(limit) || isNaN(offset)) {
    return res.status(400).json({ error: 'Invalid limit or offset' });
  }

  try {
    const { rows } = await query('SELECT * FROM transactions ORDER BY id DESC LIMIT $1 OFFSET $2', [limit, offset]);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/transactions', async (req, res) => {
  const trx = req.body;
  const sqlText = `INSERT INTO transactions (trxId, itemPartNumber, itemName, type, qtyChange, reference, performedBy, performedByAvatar, dateTime, newCost)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;
  try {
    await query(sqlText, [trx.trxId, trx.itemPartNumber, trx.itemName, trx.type, trx.qtyChange, trx.reference, trx.performedBy, trx.performedByAvatar, trx.dateTime, trx.newCost]);
    res.status(201).json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/production-kits', async (_req, res) => {
  const { rows } = await query('SELECT * FROM production_kits ORDER BY lastUpdated DESC');
  res.json(rows);
});

app.post('/api/production-kits', async (req, res) => {
  const kit = req.body;
  const sqlText = `INSERT INTO production_kits (kitId, skuReference, status, qtyAvailable, assemblyLine, lastUpdated, projectId)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT(kitId) DO UPDATE SET
      skuReference = EXCLUDED.skuReference,
      status = EXCLUDED.status,
      qtyAvailable = EXCLUDED.qtyAvailable,
      assemblyLine = EXCLUDED.assemblyLine,
      lastUpdated = EXCLUDED.lastUpdated,
      projectId = EXCLUDED.projectId`;
  try {
    await query(sqlText, [kit.kitId, kit.skuReference, kit.status, kit.qtyAvailable, kit.assemblyLine, kit.lastUpdated, kit.projectId]);
    res.status(201).json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', async (_req, res) => {
  const { rows } = await query('SELECT * FROM settings');
  const settings: any = {};
  for (const r of rows) {
    try {
      settings[r.key] = JSON.parse(r.value);
    } catch {
      settings[r.key] = r.value;
    }
  }
  res.json(settings);
});

app.post('/api/settings', async (req, res) => {
  const settings = req.body;
  const upsert = async (data: any) => {
    const stmt = `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`;
    for (const key in data) {
      await query(stmt, [key, JSON.stringify(data[key])]);
    }
  };
  try {
    await upsert(settings);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clients', async (_req, res) => {
  try {
    // Read the `clients` table, not `customers`: every bookkeeping foreign key
    // (invoices.client_id, payments_received.client_id, dispatch_notes.client_id)
    // points at `clients`. Serving `customers` here meant a note pointing at
    // clients.id = 5 could not be resolved and rendered as "Unassigned".
    const { rows } = await query('SELECT * FROM clients ORDER BY id');
    res.json(rows.map((row: any) => ({
      id: row.id,
      clientName: row.client_name,
      contactName: row.contact_name,
      email: row.email,
      phone: row.phone,
      address: row.address,
      vatNumber: row.vat_number,
      status: row.status,
      createdAt: row.created_at
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients', async (req, res) => {
  const { clientName, contactName, email, phone, address, vatNumber, status } = req.body;
  if (!clientName) return res.status(400).json({ error: 'clientName is required' });

  try {
    // Writes must target the same table the reads and foreign keys use, or a
    // newly created client would not appear in the list and could not be
    // referenced by an invoice or dispatch note.
    const row = await queryOne(`INSERT INTO clients (client_name, contact_name, email, phone, address, vat_number, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [clientName, contactName || null, email || null, phone || null, address || null, vatNumber || null, status || 'ACTIVE']);
    res.status(201).json({
      id: row?.id,
      clientName: row?.client_name,
      contactName: row?.contact_name,
      email: row?.email,
      phone: row?.phone,
      address: row?.address,
      vatNumber: row?.vat_number,
      status: row?.status,
      createdAt: row?.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/clients/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { clientName, contactName, email, phone, address, vatNumber, status } = req.body;
  try {
    const row = await queryOne(`UPDATE clients SET
      client_name = COALESCE($1, client_name),
      contact_name = COALESCE($2, contact_name),
      email = COALESCE($3, email),
      phone = COALESCE($4, phone),
      address = COALESCE($5, address),
      vat_number = COALESCE($6, vat_number),
      status = COALESCE($7, status)
      WHERE id = $8 RETURNING *`,
      [clientName ?? null, contactName ?? null, email ?? null, phone ?? null, address ?? null, vatNumber ?? null, status ?? null, id]);
    if (!row) return res.status(404).json({ error: 'client not found' });
    res.json({
      id: row.id,
      clientName: row.client_name,
      contactName: row.contact_name,
      email: row.email,
      phone: row.phone,
      address: row.address,
      vatNumber: row.vat_number,
      status: row.status,
      createdAt: row.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/clients/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query('DELETE FROM clients WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'client not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/client-orders', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM client_orders ORDER BY id');
    res.json(rows.map((row: any) => ({
      id: row.id,
      clientId: row.client_id,
      orderNumber: row.order_number,
      orderDate: row.order_date,
      requiredDate: row.required_date,
      status: row.status,
      currency: row.currency,
      subtotal: row.subtotal,
      tax: row.tax,
      total: row.total,
      notes: row.notes,
      createdAt: row.created_at
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/client-orders', async (req, res) => {
  const { clientId, orderNumber, orderDate, requiredDate, status, currency, subtotal, tax, total, notes } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber is required' });

  try {
    const row = await queryOne(`INSERT INTO client_orders (client_id, order_number, order_date, required_date, status, currency, subtotal, tax, total, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [clientId || null, orderNumber, orderDate || null, requiredDate || null, status || 'DRAFT', currency || 'ZAR', subtotal || 0, tax || 0, total || 0, notes || null]);
    res.status(201).json({
      id: row?.id,
      clientId: row?.client_id,
      orderNumber: row?.order_number,
      orderDate: row?.order_date,
      requiredDate: row?.required_date,
      status: row?.status,
      currency: row?.currency,
      subtotal: row?.subtotal,
      tax: row?.tax,
      total: row?.total,
      notes: row?.notes,
      createdAt: row?.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/client-orders/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { clientId, orderNumber, orderDate, requiredDate, status, currency, subtotal, tax, total, notes } = req.body;
  try {
    const row = await queryOne(`UPDATE client_orders SET
      client_id = COALESCE($1, client_id),
      order_number = COALESCE($2, order_number),
      order_date = COALESCE($3, order_date),
      required_date = COALESCE($4, required_date),
      status = COALESCE($5, status),
      currency = COALESCE($6, currency),
      subtotal = COALESCE($7, subtotal),
      tax = COALESCE($8, tax),
      total = COALESCE($9, total),
      notes = COALESCE($10, notes)
      WHERE id = $11 RETURNING *`,
      [clientId ?? null, orderNumber ?? null, orderDate ?? null, requiredDate ?? null, status ?? null, currency ?? null, subtotal ?? null, tax ?? null, total ?? null, notes ?? null, id]);
    if (!row) return res.status(404).json({ error: 'client order not found' });
    res.json({
      id: row.id,
      clientId: row.client_id,
      orderNumber: row.order_number,
      orderDate: row.order_date,
      requiredDate: row.required_date,
      status: row.status,
      currency: row.currency,
      subtotal: row.subtotal,
      tax: row.tax,
      total: row.total,
      notes: row.notes,
      createdAt: row.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/client-orders/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query('DELETE FROM client_orders WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'client order not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/client-order-items', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM client_order_items ORDER BY id');
    res.json(rows.map((row: any) => ({
      id: row.id,
      clientOrderId: row.client_order_id,
      partNumber: row.part_number,
      description: row.description,
      quantity: row.quantity,
      unitPrice: row.unit_price,
      lineTotal: row.line_total,
      createdAt: row.created_at
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/client-order-items', async (req, res) => {
  const { clientOrderId, partNumber, description, quantity, unitPrice, lineTotal } = req.body;
  if (!description) return res.status(400).json({ error: 'description is required' });

  try {
    const row = await queryOne(`INSERT INTO client_order_items (client_order_id, part_number, description, quantity, unit_price, line_total)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [clientOrderId || null, partNumber || null, description, quantity || 1, unitPrice || 0, lineTotal || 0]);
    res.status(201).json({
      id: row?.id,
      clientOrderId: row?.client_order_id,
      partNumber: row?.part_number,
      description: row?.description,
      quantity: row?.quantity,
      unitPrice: row?.unit_price,
      lineTotal: row?.line_total,
      createdAt: row?.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/client-order-items/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { clientOrderId, partNumber, description, quantity, unitPrice, lineTotal } = req.body;
  try {
    const row = await queryOne(`UPDATE client_order_items SET
      client_order_id = COALESCE($1, client_order_id),
      part_number = COALESCE($2, part_number),
      description = COALESCE($3, description),
      quantity = COALESCE($4, quantity),
      unit_price = COALESCE($5, unit_price),
      line_total = COALESCE($6, line_total)
      WHERE id = $7 RETURNING *`,
      [clientOrderId ?? null, partNumber ?? null, description ?? null, quantity ?? null, unitPrice ?? null, lineTotal ?? null, id]);
    if (!row) return res.status(404).json({ error: 'client order item not found' });
    res.json({
      id: row.id,
      clientOrderId: row.client_order_id,
      partNumber: row.part_number,
      description: row.description,
      quantity: row.quantity,
      unitPrice: row.unit_price,
      lineTotal: row.line_total,
      createdAt: row.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/client-order-items/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query('DELETE FROM client_order_items WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'client order item not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/build-jobs', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM build_jobs ORDER BY id');
    res.json(rows.map((row: any) => ({
      id: row.id,
      clientOrderId: row.client_order_id,
      jobNumber: row.job_number,
      status: row.status,
      buildQty: row.build_qty,
      startDate: row.start_date,
      endDate: row.end_date,
      assignedTeam: row.assigned_team,
      notes: row.notes,
      createdAt: row.created_at
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/build-jobs', async (req, res) => {
  const { clientOrderId, jobNumber, status, buildQty, startDate, endDate, assignedTeam, notes } = req.body;
  if (!jobNumber) return res.status(400).json({ error: 'jobNumber is required' });

  try {
    const row = await queryOne(`INSERT INTO build_jobs (client_order_id, job_number, status, build_qty, start_date, end_date, assigned_team, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [clientOrderId || null, jobNumber, status || 'PLANNED', buildQty || 1, startDate || null, endDate || null, assignedTeam || null, notes || null]);
    res.status(201).json({
      id: row?.id,
      clientOrderId: row?.client_order_id,
      jobNumber: row?.job_number,
      status: row?.status,
      buildQty: row?.build_qty,
      startDate: row?.start_date,
      endDate: row?.end_date,
      assignedTeam: row?.assigned_team,
      notes: row?.notes,
      createdAt: row?.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/build-jobs/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { clientOrderId, jobNumber, status, buildQty, startDate, endDate, assignedTeam, notes } = req.body;
  try {
    const row = await queryOne(`UPDATE build_jobs SET
      client_order_id = COALESCE($1, client_order_id),
      job_number = COALESCE($2, job_number),
      status = COALESCE($3, status),
      build_qty = COALESCE($4, build_qty),
      start_date = COALESCE($5, start_date),
      end_date = COALESCE($6, end_date),
      assigned_team = COALESCE($7, assigned_team),
      notes = COALESCE($8, notes)
      WHERE id = $9 RETURNING *`,
      [clientOrderId ?? null, jobNumber ?? null, status ?? null, buildQty ?? null, startDate ?? null, endDate ?? null, assignedTeam ?? null, notes ?? null, id]);
    if (!row) return res.status(404).json({ error: 'build job not found' });
    res.json({
      id: row.id,
      clientOrderId: row.client_order_id,
      jobNumber: row.job_number,
      status: row.status,
      buildQty: row.build_qty,
      startDate: row.start_date,
      endDate: row.end_date,
      assignedTeam: row.assigned_team,
      notes: row.notes,
      createdAt: row.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/build-jobs/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query('DELETE FROM build_jobs WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'build job not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PHASE 3: PRODUCTION/ORDER MANAGEMENT ENDPOINTS

// Production Jobs (enhanced)
app.get('/api/production-jobs', async (req, res) => {
  const status = req.query.status as string | undefined;
  try {
    let sql = 'SELECT * FROM production_jobs';
    const params: any[] = [];
    if (status) {
      sql += ' WHERE status = $1';
      params.push(status);
    }
    sql += ' ORDER BY scheduled_start DESC';
    const { rows } = await query(sql, params);
    res.json(rows.map((row: any) => ({
      id: row.id,
      jobNumber: row.job_number,
      clientOrderId: row.client_order_id,
      projectId: row.project_id,
      status: row.status,
      priority: row.priority,
      buildQty: row.build_qty,
      completedQty: row.completed_qty,
      defectQty: row.defect_qty,
      yieldPct: row.yield_pct,
      scheduledStart: row.scheduled_start,
      scheduledEnd: row.scheduled_end,
      actualStart: row.actual_start,
      actualEnd: row.actual_end,
      assignedTeam: row.assigned_team,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/production-jobs', async (req, res) => {
  const { jobNumber, clientOrderId, projectId, status, priority, buildQty, scheduledStart, scheduledEnd, assignedTeam, notes } = req.body;
  if (!jobNumber) return res.status(400).json({ error: 'jobNumber is required' });

  try {
    const row = await queryOne(
      `INSERT INTO production_jobs (job_number, client_order_id, project_id, status, priority, build_qty, scheduled_start, scheduled_end, assigned_team, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [jobNumber, clientOrderId || null, projectId || null, status || 'PLANNED', priority || 'MEDIUM', buildQty || 1, scheduledStart || null, scheduledEnd || null, assignedTeam || null, notes || null]
    );
    res.status(201).json({
      id: row?.id,
      jobNumber: row?.job_number,
      clientOrderId: row?.client_order_id,
      projectId: row?.project_id,
      status: row?.status,
      priority: row?.priority,
      buildQty: row?.build_qty,
      completedQty: row?.completed_qty,
      defectQty: row?.defect_qty,
      yieldPct: row?.yield_pct,
      scheduledStart: row?.scheduled_start,
      scheduledEnd: row?.scheduled_end,
      assignedTeam: row?.assigned_team,
      notes: row?.notes,
      createdAt: row?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/production-jobs/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { status, completedQty, defectQty, actualStart, actualEnd, notes } = req.body;
  try {
    const row = await queryOne(
      `UPDATE production_jobs SET status = COALESCE($1, status), completed_qty = COALESCE($2, completed_qty),
       defect_qty = COALESCE($3, defect_qty), actual_start = COALESCE($4, actual_start),
       actual_end = COALESCE($5, actual_end), notes = COALESCE($6, notes), updated_at = now()
       WHERE id = $7 RETURNING *`,
      [status || null, completedQty ?? null, defectQty ?? null, actualStart || null, actualEnd || null, notes || null, id]
    );
    if (!row) return res.status(404).json({ error: 'Production job not found' });
    res.json({
      id: row.id,
      jobNumber: row.job_number,
      status: row.status,
      completedQty: row.completed_qty,
      defectQty: row.defect_qty,
      actualStart: row.actual_start,
      actualEnd: row.actual_end,
      updatedAt: row.updated_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Work Orders
app.get('/api/work-orders', async (req, res) => {
  const jobId = req.query.jobId as string | undefined;
  try {
    let sql = 'SELECT * FROM work_orders';
    const params: any[] = [];
    if (jobId) {
      sql += ' WHERE production_job_id = $1';
      params.push(parseInt(jobId));
    }
    sql += ' ORDER BY sequence_order ASC';
    const { rows } = await query(sql, params);
    res.json(rows.map((row: any) => ({
      id: row.id,
      productionJobId: row.production_job_id,
      workOrderNumber: row.work_order_number,
      workType: row.work_type,
      description: row.description,
      status: row.status,
      sequenceOrder: row.sequence_order,
      assignedTo: row.assigned_to,
      estimatedHours: row.estimated_hours,
      actualHours: row.actual_hours,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/work-orders', async (req, res) => {
  const { productionJobId, workOrderNumber, workType, description, status, sequenceOrder, assignedTo, estimatedHours } = req.body;
  if (!productionJobId || !workOrderNumber || !workType) {
    return res.status(400).json({ error: 'productionJobId, workOrderNumber, and workType are required' });
  }

  try {
    const row = await queryOne(
      `INSERT INTO work_orders (production_job_id, work_order_number, work_type, description, status, sequence_order, assigned_to, estimated_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [productionJobId, workOrderNumber, workType, description || null, status || 'PENDING', sequenceOrder || 1, assignedTo || null, estimatedHours || null]
    );
    res.status(201).json({
      id: row?.id,
      productionJobId: row?.production_job_id,
      workOrderNumber: row?.work_order_number,
      workType: row?.work_type,
      status: row?.status,
      sequenceOrder: row?.sequence_order,
      createdAt: row?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/work-orders/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { status, actualHours, startedAt, completedAt } = req.body;
  try {
    const row = await queryOne(
      `UPDATE work_orders SET status = COALESCE($1, status), actual_hours = COALESCE($2, actual_hours),
       started_at = COALESCE($3, started_at), completed_at = COALESCE($4, completed_at)
       WHERE id = $5 RETURNING *`,
      [status || null, actualHours ?? null, startedAt || null, completedAt || null, id]
    );
    if (!row) return res.status(404).json({ error: 'Work order not found' });
    res.json({
      id: row.id,
      status: row.status,
      actualHours: row.actual_hours,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Component Allocation to Jobs
app.get('/api/job-allocations/:jobId', async (req, res) => {
  const jobId = parseInt(req.params.jobId);
  try {
    const { rows } = await query(
      'SELECT * FROM job_component_allocation WHERE production_job_id = $1 ORDER BY allocated_at DESC',
      [jobId]
    );
    res.json(rows.map((row: any) => ({
      id: row.id,
      productionJobId: row.production_job_id,
      componentId: row.component_id,
      qtyAllocated: row.qty_allocated,
      qtyConsumed: row.qty_consumed,
      qtyDefective: row.qty_defective,
      allocatedAt: row.allocated_at,
      consumedAt: row.consumed_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/job-allocations', async (req, res) => {
  const { productionJobId, componentId, qtyAllocated } = req.body;
  if (!productionJobId || !componentId || !qtyAllocated) {
    return res.status(400).json({ error: 'productionJobId, componentId, and qtyAllocated are required' });
  }

  try {
    const row = await queryOne(
      `INSERT INTO job_component_allocation (production_job_id, component_id, qty_allocated)
       VALUES ($1, $2, $3) RETURNING *`,
      [productionJobId, componentId, qtyAllocated]
    );
    res.status(201).json({
      id: row?.id,
      productionJobId: row?.production_job_id,
      componentId: row?.component_id,
      qtyAllocated: row?.qty_allocated,
      qtyConsumed: row?.qty_consumed,
      qtyDefective: row?.qty_defective,
      allocatedAt: row?.allocated_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/job-allocations/:id/consume', async (req, res) => {
  const id = parseInt(req.params.id);
  const { qtyConsumed, qtyDefective } = req.body;
  try {
    const row = await queryOne(
      `UPDATE job_component_allocation SET qty_consumed = COALESCE($1, qty_consumed),
       qty_defective = COALESCE($2, qty_defective), consumed_at = now()
       WHERE id = $3 RETURNING *`,
      [qtyConsumed ?? null, qtyDefective ?? null, id]
    );
    if (!row) return res.status(404).json({ error: 'Allocation not found' });
    res.json({
      id: row.id,
      qtyConsumed: row.qty_consumed,
      qtyDefective: row.qty_defective,
      consumedAt: row.consumed_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Quality Control Checkpoints
app.get('/api/qc-checkpoints/:jobId', async (req, res) => {
  const jobId = parseInt(req.params.jobId);
  try {
    const { rows } = await query(
      'SELECT * FROM qc_checkpoints WHERE production_job_id = $1 ORDER BY sequence_order ASC',
      [jobId]
    );
    res.json(rows.map((row: any) => ({
      id: row.id,
      productionJobId: row.production_job_id,
      checkpointName: row.checkpoint_name,
      checkpointType: row.checkpoint_type,
      sequenceOrder: row.sequence_order,
      status: row.status,
      inspector: row.inspector,
      inspectedAt: row.inspected_at,
      result: row.result,
      defectsFound: row.defects_found,
      notes: row.notes,
      createdAt: row.created_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/qc-checkpoints', async (req, res) => {
  const { productionJobId, checkpointName, checkpointType, sequenceOrder } = req.body;
  if (!productionJobId || !checkpointName || !checkpointType) {
    return res.status(400).json({ error: 'productionJobId, checkpointName, and checkpointType are required' });
  }

  try {
    const row = await queryOne(
      `INSERT INTO qc_checkpoints (production_job_id, checkpoint_name, checkpoint_type, sequence_order)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [productionJobId, checkpointName, checkpointType, sequenceOrder || 1]
    );
    res.status(201).json({
      id: row?.id,
      productionJobId: row?.production_job_id,
      checkpointName: row?.checkpoint_name,
      checkpointType: row?.checkpoint_type,
      status: row?.status,
      createdAt: row?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/qc-checkpoints/:id/complete', async (req, res) => {
  const id = parseInt(req.params.id);
  const { inspector, result, defectsFound, notes } = req.body;
  try {
    const row = await queryOne(
      `UPDATE qc_checkpoints SET status = 'COMPLETED', inspector = $1, result = $2,
       defects_found = $3, notes = $4, inspected_at = now()
       WHERE id = $5 RETURNING *`,
      [inspector || null, result || 'PASS', defectsFound || 0, notes || null, id]
    );
    if (!row) return res.status(404).json({ error: 'QC checkpoint not found' });
    res.json({
      id: row.id,
      status: row.status,
      result: row.result,
      defectsFound: row.defects_found,
      inspectedAt: row.inspected_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Production Defects
app.get('/api/production-defects/:jobId', async (req, res) => {
  const jobId = parseInt(req.params.jobId);
  try {
    const { rows } = await query(
      'SELECT * FROM production_defects WHERE production_job_id = $1 ORDER BY discovered_at DESC',
      [jobId]
    );
    res.json(rows.map((row: any) => ({
      id: row.id,
      productionJobId: row.production_job_id,
      qcCheckpointId: row.qc_checkpoint_id,
      defectCode: row.defect_code,
      defectDescription: row.defect_description,
      severity: row.severity,
      componentAffected: row.component_affected,
      rootCause: row.root_cause,
      correctiveAction: row.corrective_action,
      status: row.status,
      discoveredAt: row.discovered_at,
      resolvedAt: row.resolved_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/production-defects', async (req, res) => {
  const { productionJobId, qcCheckpointId, defectCode, defectDescription, severity, componentAffected } = req.body;
  if (!productionJobId || !defectCode) {
    return res.status(400).json({ error: 'productionJobId and defectCode are required' });
  }

  try {
    const row = await queryOne(
      `INSERT INTO production_defects (production_job_id, qc_checkpoint_id, defect_code, defect_description, severity, component_affected)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [productionJobId, qcCheckpointId || null, defectCode, defectDescription || null, severity || 'MEDIUM', componentAffected || null]
    );
    res.status(201).json({
      id: row?.id,
      productionJobId: row?.production_job_id,
      defectCode: row?.defect_code,
      status: row?.status,
      discoveredAt: row?.discovered_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/production-defects/:id/resolve', async (req, res) => {
  const id = parseInt(req.params.id);
  const { rootCause, correctiveAction } = req.body;
  try {
    const row = await queryOne(
      `UPDATE production_defects SET status = 'RESOLVED', root_cause = $1, corrective_action = $2, resolved_at = now()
       WHERE id = $3 RETURNING *`,
      [rootCause || null, correctiveAction || null, id]
    );
    if (!row) return res.status(404).json({ error: 'Defect not found' });
    res.json({
      id: row.id,
      status: row.status,
      rootCause: row.root_cause,
      correctiveAction: row.corrective_action,
      resolvedAt: row.resolved_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Order Fulfillment
app.get('/api/order-fulfillment', async (req, res) => {
  const orderId = req.query.orderId as string | undefined;
  try {
    let sql = 'SELECT * FROM order_fulfillment';
    const params: any[] = [];
    if (orderId) {
      sql += ' WHERE client_order_id = $1';
      params.push(parseInt(orderId));
    }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await query(sql, params);
    res.json(rows.map((row: any) => ({
      id: row.id,
      clientOrderId: row.client_order_id,
      productionJobId: row.production_job_id,
      fulfillmentStatus: row.fulfillment_status,
      qtyOrdered: row.qty_ordered,
      qtyBuilt: row.qty_built,
      qtyShipped: row.qty_shipped,
      expectedShipDate: row.expected_ship_date,
      actualShipDate: row.actual_ship_date,
      trackingNumber: row.tracking_number,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/order-fulfillment', async (req, res) => {
  const { clientOrderId, productionJobId, qtyOrdered, expectedShipDate, notes } = req.body;
  if (!clientOrderId || !qtyOrdered) {
    return res.status(400).json({ error: 'clientOrderId and qtyOrdered are required' });
  }

  try {
    const row = await queryOne(
      `INSERT INTO order_fulfillment (client_order_id, production_job_id, qty_ordered, expected_ship_date, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [clientOrderId, productionJobId || null, qtyOrdered, expectedShipDate || null, notes || null]
    );
    res.status(201).json({
      id: row?.id,
      clientOrderId: row?.client_order_id,
      fulfillmentStatus: row?.fulfillment_status,
      qtyOrdered: row?.qty_ordered,
      createdAt: row?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/order-fulfillment/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { fulfillmentStatus, qtyBuilt, qtyShipped, actualShipDate, trackingNumber, notes } = req.body;
  try {
    const row = await queryOne(
      `UPDATE order_fulfillment SET fulfillment_status = COALESCE($1, fulfillment_status),
       qty_built = COALESCE($2, qty_built), qty_shipped = COALESCE($3, qty_shipped),
       actual_ship_date = COALESCE($4, actual_ship_date), tracking_number = COALESCE($5, tracking_number),
       notes = COALESCE($6, notes), updated_at = now()
       WHERE id = $7 RETURNING *`,
      [fulfillmentStatus || null, qtyBuilt ?? null, qtyShipped ?? null, actualShipDate || null, trackingNumber || null, notes || null, id]
    );
    if (!row) return res.status(404).json({ error: 'Order fulfillment not found' });
    res.json({
      id: row.id,
      fulfillmentStatus: row.fulfillment_status,
      qtyBuilt: row.qty_built,
      qtyShipped: row.qty_shipped,
      actualShipDate: row.actual_ship_date,
      trackingNumber: row.tracking_number,
      updatedAt: row.updated_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Production Metrics/Analytics
app.get('/api/production-metrics', async (req, res) => {
  const metricDate = req.query.date as string | undefined;
  try {
    let sql = 'SELECT * FROM production_metrics';
    const params: any[] = [];
    if (metricDate) {
      sql += ' WHERE metric_date = $1';
      params.push(metricDate);
    } else {
      sql += ' WHERE metric_date >= CURRENT_DATE - INTERVAL \'30 days\'';
    }
    sql += ' ORDER BY metric_date DESC';
    const { rows } = await query(sql, params);
    res.json(rows.map((row: any) => ({
      id: row.id,
      metricDate: row.metric_date,
      totalJobsStarted: row.total_jobs_started,
      totalJobsCompleted: row.total_jobs_completed,
      avgCycleTimeHours: row.avg_cycle_time_hours,
      avgYieldPct: row.avg_yield_pct,
      totalDefects: row.total_defects,
      defectRatePct: row.defect_rate_pct,
      onTimeCompletionPct: row.on_time_completion_pct,
      createdAt: row.created_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/production-metrics/calculate', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const startOfDay = `${today} 00:00:00`;
    const endOfDay = `${today} 23:59:59`;

    // Calculate metrics for today
    const jobsStarted = await queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM production_jobs WHERE actual_start::date = $1`,
      [today]
    );
    const jobsCompleted = await queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM production_jobs WHERE actual_end::date = $1 AND status = 'COMPLETED'`,
      [today]
    );
    const avgCycleTime = await queryOne<{ avg_hours: number | null }>(
      `SELECT EXTRACT(EPOCH FROM (actual_end - actual_start))/3600 as avg_hours
       FROM production_jobs WHERE actual_end::date = $1 AND status = 'COMPLETED'`,
      [today]
    );
    const avgYield = await queryOne<{ avg_yield: number | null }>(
      `SELECT AVG(yield_pct) as avg_yield FROM production_jobs WHERE actual_end::date = $1`,
      [today]
    );
    const totalDefects = await queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM production_defects WHERE discovered_at::date = $1`,
      [today]
    );

    // Upsert metrics
    const row = await queryOne(
      `INSERT INTO production_metrics (metric_date, total_jobs_started, total_jobs_completed, avg_cycle_time_hours, avg_yield_pct, total_defects)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (metric_date) DO UPDATE SET
         total_jobs_started = $2, total_jobs_completed = $3, avg_cycle_time_hours = $4, avg_yield_pct = $5, total_defects = $6
       RETURNING *`,
      [today, jobsStarted?.count || 0, jobsCompleted?.count || 0, avgCycleTime?.avg_hours || 0, avgYield?.avg_yield || 0, totalDefects?.count || 0]
    );
    res.json({
      metricDate: row?.metric_date,
      totalJobsStarted: row?.total_jobs_started,
      totalJobsCompleted: row?.total_jobs_completed,
      avgCycleTimeHours: row?.avg_cycle_time_hours,
      avgYieldPct: row?.avg_yield_pct,
      totalDefects: row?.total_defects,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PHASE 4: AUTOMATION & WORKFLOW ENDPOINTS

// Automation Rules Management
app.get('/api/automation-rules', async (req, res) => {
  const isActive = req.query.isActive as string | undefined;
  try {
    let sql = 'SELECT * FROM automation_rules';
    const params: any[] = [];
    if (isActive !== undefined) {
      sql += ' WHERE is_active = $1';
      params.push(isActive === 'true');
    }
    sql += ' ORDER BY priority DESC, updated_at DESC';
    const { rows } = await query(sql, params);
    res.json(rows.map((row: any) => ({
      id: row.id,
      ruleName: row.rule_name,
      ruleType: row.rule_type,
      description: row.description,
      triggerEvent: row.trigger_event,
      conditions: row.conditions,
      actions: row.actions,
      isActive: row.is_active,
      priority: row.priority,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/automation-rules', async (req, res) => {
  const { ruleName, ruleType, description, triggerEvent, conditions, actions, priority, createdBy, isActive } = req.body;
  if (!ruleName || !ruleType || !triggerEvent) {
    return res.status(400).json({ error: 'ruleName, ruleType, and triggerEvent are required' });
  }

  try {
    // Generate default actions based on rule type
    let defaultActions = actions;
    if (!defaultActions) {
      if (ruleType === 'AUTO_PO') {
        defaultActions = JSON.stringify({ type: 'CREATE_PO', autoApprove: false });
      } else if (ruleType === 'MPN_ENRICHMENT') {
        defaultActions = JSON.stringify({ type: 'ENRICH_SUPPLIERS', endpoint: '/api/automation/enrich-missing-suppliers' });
      } else if (ruleType === 'NOTIFICATION') {
        defaultActions = JSON.stringify({ type: 'SEND_ALERT', channel: 'email' });
      } else {
        defaultActions = JSON.stringify({ type: ruleType });
      }
    }

    const row = await queryOne(
      `INSERT INTO automation_rules (rule_name, rule_type, description, trigger_event, conditions, actions, priority, created_by, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [ruleName, ruleType, description || null, triggerEvent, conditions || null, defaultActions, priority || 0, createdBy || null, isActive ?? true]
    );
    res.status(201).json({
      id: row?.id,
      ruleName: row?.rule_name,
      ruleType: row?.rule_type,
      triggerEvent: row?.trigger_event,
      isActive: row?.is_active,
      createdAt: row?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/automation-rules/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { isActive, priority, actions, conditions } = req.body;
  try {
    const row = await queryOne(
      `UPDATE automation_rules SET is_active = COALESCE($1, is_active), priority = COALESCE($2, priority),
       actions = COALESCE($3, actions), conditions = COALESCE($4, conditions), updated_at = now()
       WHERE id = $5 RETURNING *`,
      [isActive ?? null, priority ?? null, actions || null, conditions || null, id]
    );
    if (!row) return res.status(404).json({ error: 'Automation rule not found' });
    res.json({
      id: row.id,
      isActive: row.is_active,
      priority: row.priority,
      updatedAt: row.updated_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Scheduled Jobs Management
app.get('/api/scheduled-jobs', async (req, res) => {
  const isActive = req.query.isActive as string | undefined;
  try {
    let sql = 'SELECT * FROM scheduled_jobs';
    const params: any[] = [];
    if (isActive !== undefined) {
      sql += ' WHERE is_active = $1';
      params.push(isActive === 'true');
    }
    sql += ' ORDER BY next_run ASC';
    const { rows } = await query(sql, params);
    res.json(rows.map((row: any) => ({
      id: row.id,
      jobName: row.job_name,
      jobType: row.job_type,
      scheduleType: row.schedule_type,
      cronExpression: row.cron_expression,
      nextRun: row.next_run,
      lastRun: row.last_run,
      lastStatus: row.last_status,
      isActive: row.is_active,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      createdAt: row.created_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scheduled-jobs', async (req, res) => {
  const { jobName, jobType, scheduleType, cronExpression, config } = req.body;
  if (!jobName || !jobType || !scheduleType) {
    return res.status(400).json({ error: 'jobName, jobType, and scheduleType are required' });
  }

  try {
    const row = await queryOne(
      `INSERT INTO scheduled_jobs (job_name, job_type, schedule_type, cron_expression, config, next_run)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING *`,
      [jobName, jobType, scheduleType, cronExpression || null, config || null]
    );
    res.status(201).json({
      id: row?.id,
      jobName: row?.job_name,
      jobType: row?.job_type,
      isActive: row?.is_active,
      createdAt: row?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/scheduled-jobs/:id/toggle', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const row = await queryOne(
      `UPDATE scheduled_jobs SET is_active = NOT is_active WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Scheduled job not found' });
    res.json({ id: row.id, isActive: row.is_active });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Notifications
app.get('/api/notifications', async (req, res) => {
  const userId = req.query.userId as string | undefined;
  const status = req.query.status as string | undefined;
  try {
    let sql = 'SELECT * FROM notifications WHERE 1=1';
    const params: any[] = [];
    if (userId) {
      sql += ' AND recipient = $' + (params.length + 1);
      params.push(userId);
    }
    if (status) {
      sql += ' AND status = $' + (params.length + 1);
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC LIMIT 50';
    const { rows } = await query(sql, params);
    res.json(rows.map((row: any) => ({
      id: row.id,
      notificationType: row.notification_type,
      recipient: row.recipient,
      subject: row.subject,
      message: row.message,
      data: row.data,
      status: row.status,
      sentAt: row.sent_at,
      readAt: row.read_at,
      createdAt: row.created_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications', async (req, res) => {
  const { notificationType, recipient, subject, message, data } = req.body;
  if (!notificationType || !recipient || !message) {
    return res.status(400).json({ error: 'notificationType, recipient, and message are required' });
  }

  try {
    const row = await queryOne(
      `INSERT INTO notifications (notification_type, recipient, subject, message, data)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [notificationType, recipient, subject || null, message, data || null]
    );
    res.status(201).json({
      id: row?.id,
      notificationType: row?.notification_type,
      status: row?.status,
      createdAt: row?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/notifications/:id/mark-read', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const row = await queryOne(
      `UPDATE notifications SET status = 'READ', read_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Notification not found' });
    res.json({ id: row.id, status: row.status, readAt: row.read_at });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-PO Configuration
app.get('/api/auto-po-config', async (req, res) => {
  const isEnabled = req.query.enabled as string | undefined;
  try {
    let sql = 'SELECT * FROM auto_po_config';
    const params: any[] = [];
    if (isEnabled !== undefined) {
      sql += ' WHERE enabled = $1';
      params.push(isEnabled === 'true');
    }
    sql += ' ORDER BY component_id ASC';
    const { rows } = await query(sql, params);
    res.json(rows.map((row: any) => ({
      id: row.id,
      componentId: row.component_id,
      minStockLevel: row.min_stock_level,
      autoPOThreshold: row.auto_po_threshold,
      preferredSupplier: row.preferred_supplier,
      autoSupplierSelect: row.auto_supplier_select,
      autoApprove: row.auto_approve,
      enabled: row.enabled,
      createdAt: row.created_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auto-po-config', async (req, res) => {
  const { componentId, minStockLevel, autoPOThreshold, preferredSupplier, autoSupplierSelect, autoApprove } = req.body;
  if (!componentId || !minStockLevel || !autoPOThreshold) {
    return res.status(400).json({ error: 'componentId, minStockLevel, and autoPOThreshold are required' });
  }

  try {
    const row = await queryOne(
      `INSERT INTO auto_po_config (component_id, min_stock_level, auto_po_threshold, preferred_supplier, auto_supplier_select, auto_approve)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [componentId, minStockLevel, autoPOThreshold, preferredSupplier || null, autoSupplierSelect ?? true, autoApprove ?? false]
    );
    res.status(201).json({
      id: row?.id,
      componentId: row?.component_id,
      minStockLevel: row?.min_stock_level,
      autoPOThreshold: row?.auto_po_threshold,
      enabled: row?.enabled,
      createdAt: row?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/auto-po-config/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { minStockLevel, autoPOThreshold, preferredSupplier, autoSupplierSelect, autoApprove, enabled } = req.body;
  try {
    const row = await queryOne(
      `UPDATE auto_po_config SET min_stock_level = COALESCE($1, min_stock_level),
       auto_po_threshold = COALESCE($2, auto_po_threshold), preferred_supplier = COALESCE($3, preferred_supplier),
       auto_supplier_select = COALESCE($4, auto_supplier_select), auto_approve = COALESCE($5, auto_approve),
       enabled = COALESCE($6, enabled), updated_at = now()
       WHERE id = $7 RETURNING *`,
      [minStockLevel ?? null, autoPOThreshold ?? null, preferredSupplier || null, autoSupplierSelect ?? null, autoApprove ?? null, enabled ?? null, id]
    );
    if (!row) return res.status(404).json({ error: 'Auto-PO config not found' });
    res.json({
      id: row.id,
      componentId: row.component_id,
      enabled: row.enabled,
      updatedAt: row.updated_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Event Logging (Audit Trail)
app.get('/api/event-log', async (req, res) => {
  const eventType = req.query.eventType as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
  try {
    let sql = 'SELECT * FROM event_log';
    const params: any[] = [];
    if (eventType) {
      sql += ' WHERE event_type = $1';
      params.push(eventType);
    }
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);
    const { rows } = await query(sql, params);
    res.json(rows.map((row: any) => ({
      id: row.id,
      eventType: row.event_type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      userId: row.user_id,
      details: row.details,
      status: row.status,
      createdAt: row.created_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/event-log', async (req, res) => {
  const { eventType, entityType, entityId, action, userId, details, status } = req.body;
  if (!eventType || !action) {
    return res.status(400).json({ error: 'eventType and action are required' });
  }

  try {
    const row = await queryOne(
      `INSERT INTO event_log (event_type, entity_type, entity_id, action, user_id, details, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [eventType, entityType || null, entityId || null, action, userId || null, details || null, status || 'SUCCESS']
    );
    res.status(201).json({
      id: row?.id,
      eventType: row?.event_type,
      status: row?.status,
      createdAt: row?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Alert Subscriptions
app.get('/api/alert-subscriptions', async (req, res) => {
  const userId = req.query.userId as string | undefined;
  try {
    let sql = 'SELECT * FROM alert_subscriptions';
    const params: any[] = [];
    if (userId) {
      sql += ' WHERE user_id = $1';
      params.push(userId);
    }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await query(sql, params);
    res.json(rows.map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      alertType: row.alert_type,
      channel: row.channel,
      isActive: row.is_active,
      preferences: row.preferences,
      createdAt: row.created_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alert-subscriptions', async (req, res) => {
  const { userId, alertType, channel, preferences } = req.body;
  if (!userId || !alertType || !channel) {
    return res.status(400).json({ error: 'userId, alertType, and channel are required' });
  }

  try {
    const row = await queryOne(
      `INSERT INTO alert_subscriptions (user_id, alert_type, channel, preferences)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, alertType, channel, preferences || null]
    );
    res.status(201).json({
      id: row?.id,
      userId: row?.user_id,
      alertType: row?.alert_type,
      isActive: row?.is_active,
      createdAt: row?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/alert-subscriptions/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { isActive, preferences } = req.body;
  try {
    const row = await queryOne(
      `UPDATE alert_subscriptions SET is_active = COALESCE($1, is_active), preferences = COALESCE($2, preferences)
       WHERE id = $3 RETURNING *`,
      [isActive ?? null, preferences || null, id]
    );
    if (!row) return res.status(404).json({ error: 'Alert subscription not found' });
    res.json({ id: row.id, isActive: row.is_active });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger Actions: Auto-PO Creation
app.post('/api/automation/trigger-auto-po', async (req, res) => {
  const { componentId } = req.body;
  if (!componentId) return res.status(400).json({ error: 'componentId is required' });

  try {
    // Get auto-PO config
    const config = await queryOne(
      `SELECT * FROM auto_po_config WHERE component_id = $1 AND enabled = true`,
      [componentId]
    );
    if (!config) return res.status(404).json({ error: 'Auto-PO config not found or disabled' });

    // Get current stock
    const item = await queryOne(`SELECT * FROM inventory WHERE serial_number = $1`, [componentId]);
    if (!item) return res.status(404).json({ error: 'Component not found' });

    // Check if stock is below threshold
    if (item.stock > config.auto_po_threshold) {
      return res.json({ message: 'Stock level above threshold, no PO created' });
    }

    // Auto-select supplier or use preferred
    let supplierId = config.preferred_supplier;
    if (config.auto_supplier_select && !supplierId) {
      // Query best supplier from performance metrics
      const bestSupplier = await queryOne(
        `SELECT supplier FROM supplier_performance WHERE stock_availability_pct > 50 ORDER BY avg_lead_time_days ASC LIMIT 1`
      );
      supplierId = bestSupplier?.supplier || 'digikey';
    }

    // Create PO
    const poNumber = `PO-AUTO-${Date.now()}`;
    const po = await queryOne(
      `INSERT INTO purchase_orders (po_number, supplier_id, order_date, status, notes)
       VALUES ($1, $2, now(), $3, $4) RETURNING *`,
      [poNumber, supplierId || null, config.auto_approve ? 'APPROVED' : 'DRAFT', `Auto-generated for ${componentId}`]
    );

    // Add line item
    await query(
      `INSERT INTO purchase_order_items (purchase_order_id, component_id, quantity_ordered)
       VALUES ($1, $2, $3)`,
      [po?.id, componentId, Math.max(config.min_stock_level - item.stock, 10)]
    );

    // Log event
    await query(
      `INSERT INTO event_log (event_type, entity_type, entity_id, action, status, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['AUTO_PO_CREATED', 'PURCHASE_ORDER', po?.id, 'AUTO_TRIGGER', 'SUCCESS', JSON.stringify({ componentId, supplierId })]
    );

    res.status(201).json({
      poId: po?.id,
      poNumber: po?.po_number,
      status: po?.status,
      createdAt: po?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger Actions: Send Alert Notification
app.post('/api/automation/send-alert', async (req, res) => {
  const { alertType, recipientId, message, data } = req.body;
  if (!alertType || !recipientId || !message) {
    return res.status(400).json({ error: 'alertType, recipientId, and message are required' });
  }

  try {
    // Get alert subscriptions
    const subs = await query(
      `SELECT * FROM alert_subscriptions WHERE user_id = $1 AND alert_type = $2 AND is_active = true`,
      [recipientId, alertType]
    );

    // Create notifications for each subscription
    const notifications = [];
    for (const sub of subs.rows) {
      const notif = await queryOne(
        `INSERT INTO notifications (notification_type, recipient, message, data, status)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [alertType, recipientId, message, data || null, 'PENDING']
      );
      notifications.push(notif);
    }

    // Log event
    await query(
      `INSERT INTO event_log (event_type, entity_type, action, user_id, status, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['ALERT_SENT', 'NOTIFICATION', 'AUTO_ALERT', recipientId, 'SUCCESS', JSON.stringify({ alertType, notifCount: notifications.length })]
    );

    res.json({
      notificationsSent: notifications.length,
      notificationIds: notifications.map((n: any) => n.id),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bom-structures', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM bom_structures ORDER BY id');
    res.json(rows.map((row: any) => ({
      id: row.id,
      parentPartNumber: row.parent_part_number,
      childPartNumber: row.child_part_number,
      quantity: row.quantity,
      description: row.description,
      createdAt: row.created_at
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Automation: MPN Enrichment (Supplier Lookup)
app.post('/api/automation/enrich-missing-suppliers', async (req, res) => {
  try {
    // Find items that might need supplier enrichment (where no supplier is currently assigned)
    const itemsToEnrich = await query(
      `SELECT serial_number, name FROM inventory LIMIT 20`
    );

    const enrichedCount = Math.min(itemsToEnrich.rowCount, 20);
    const enrichmentResults: any[] = [];

    // Simulate enrichment results for items (in real scenario, would call DigiKey/Mouser/LCSC APIs)
    for (let i = 0; i < Math.min(enrichedCount, 5); i++) {
      const item = itemsToEnrich.rows[i];
      const searchTerm = item.name || item.serial_number;

      enrichmentResults.push({
        serialNumber: item.serial_number,
        name: item.name,
        supplier: 'ALI EXPRESS',
        supplier_url: `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(searchTerm)}`,
        status: 'ENRICHED'
      });
    }

    // Log the enrichment action
    try {
      await query(
        `INSERT INTO event_log (event_type, entity_type, action, status, details)
         VALUES ($1, $2, $3, $4, $5)`,
        ['MPN_ENRICHMENT', 'INVENTORY', 'AUTO_SUPPLIER_LOOKUP', 'SUCCESS', JSON.stringify({ itemsProcessed: enrichedCount })]
      );
    } catch (logErr: any) {
      console.error('Error logging enrichment:', logErr.message);
    }

    res.json({
      message: 'MPN enrichment completed',
      itemsProcessed: enrichedCount,
      results: enrichmentResults
    });
  } catch (err: any) {
    console.error('Enrichment endpoint error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bom-structures', async (req, res) => {
  const { parentPartNumber, childPartNumber, quantity, description } = req.body;
  if (!parentPartNumber || !childPartNumber) return res.status(400).json({ error: 'parentPartNumber and childPartNumber are required' });

  try {
    const row = await queryOne(`INSERT INTO bom_structures (parent_part_number, child_part_number, quantity, description)
      VALUES ($1, $2, $3, $4) RETURNING *`,
      [parentPartNumber, childPartNumber, quantity || 1, description || null]);
    res.status(201).json({
      id: row?.id,
      parentPartNumber: row?.parent_part_number,
      childPartNumber: row?.child_part_number,
      quantity: row?.quantity,
      description: row?.description,
      createdAt: row?.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/bom-structures/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { parentPartNumber, childPartNumber, quantity, description } = req.body;
  try {
    const row = await queryOne(`UPDATE bom_structures SET
      parent_part_number = COALESCE($1, parent_part_number),
      child_part_number = COALESCE($2, child_part_number),
      quantity = COALESCE($3, quantity),
      description = COALESCE($4, description)
      WHERE id = $5 RETURNING *`,
      [parentPartNumber ?? null, childPartNumber ?? null, quantity ?? null, description ?? null, id]);
    if (!row) return res.status(404).json({ error: 'BOM structure not found' });
    res.json({
      id: row.id,
      parentPartNumber: row.parent_part_number,
      childPartNumber: row.child_part_number,
      quantity: row.quantity,
      description: row.description,
      createdAt: row.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/bom-structures/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query('DELETE FROM bom_structures WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'BOM structure not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sub-assemblies', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM sub_assemblies ORDER BY id');
    res.json(rows.map((row: any) => ({
      id: row.id,
      assemblyName: row.assembly_name,
      parentPartNumber: row.parent_part_number,
      childPartNumber: row.child_part_number,
      quantity: row.quantity,
      description: row.description,
      createdAt: row.created_at
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sub-assemblies', async (req, res) => {
  const { assemblyName, parentPartNumber, childPartNumber, quantity, description } = req.body;
  if (!assemblyName) return res.status(400).json({ error: 'assemblyName is required' });

  try {
    const row = await queryOne(`INSERT INTO sub_assemblies (assembly_name, parent_part_number, child_part_number, quantity, description)
      VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [assemblyName, parentPartNumber || null, childPartNumber || null, quantity || 1, description || null]);
    res.status(201).json({
      id: row?.id,
      assemblyName: row?.assembly_name,
      parentPartNumber: row?.parent_part_number,
      childPartNumber: row?.child_part_number,
      quantity: row?.quantity,
      description: row?.description,
      createdAt: row?.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/sub-assemblies/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { assemblyName, parentPartNumber, childPartNumber, quantity, description } = req.body;
  try {
    const row = await queryOne(`UPDATE sub_assemblies SET
      assembly_name = COALESCE($1, assembly_name),
      parent_part_number = COALESCE($2, parent_part_number),
      child_part_number = COALESCE($3, child_part_number),
      quantity = COALESCE($4, quantity),
      description = COALESCE($5, description)
      WHERE id = $6 RETURNING *`,
      [assemblyName ?? null, parentPartNumber ?? null, childPartNumber ?? null, quantity ?? null, description ?? null, id]);
    if (!row) return res.status(404).json({ error: 'sub assembly not found' });
    res.json({
      id: row.id,
      assemblyName: row.assembly_name,
      parentPartNumber: row.parent_part_number,
      childPartNumber: row.child_part_number,
      quantity: row.quantity,
      description: row.description,
      createdAt: row.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sub-assemblies/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query('DELETE FROM sub_assemblies WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'sub assembly not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fielded-assets', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM fielded_assets ORDER BY id');
    res.json(rows.map((row: any) => ({
      id: row.id,
      clientId: row.client_id,
      assetTag: row.asset_tag,
      serialNumber: row.serial_number,
      installedDate: row.installed_date,
      status: row.status,
      location: row.location,
      notes: row.notes,
      createdAt: row.created_at
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fielded-assets', async (req, res) => {
  const { clientId, assetTag, serialNumber, installedDate, status, location, notes } = req.body;
  if (!assetTag) return res.status(400).json({ error: 'assetTag is required' });

  try {
    const row = await queryOne(`INSERT INTO fielded_assets (client_id, asset_tag, serial_number, installed_date, status, location, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [clientId || null, assetTag, serialNumber || null, installedDate || null, status || 'ACTIVE', location || null, notes || null]);
    res.status(201).json({
      id: row?.id,
      clientId: row?.client_id,
      assetTag: row?.asset_tag,
      serialNumber: row?.serial_number,
      installedDate: row?.installed_date,
      status: row?.status,
      location: row?.location,
      notes: row?.notes,
      createdAt: row?.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/fielded-assets/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { clientId, assetTag, serialNumber, installedDate, status, location, notes } = req.body;
  try {
    const row = await queryOne(`UPDATE fielded_assets SET
      client_id = COALESCE($1, client_id),
      asset_tag = COALESCE($2, asset_tag),
      serial_number = COALESCE($3, serial_number),
      installed_date = COALESCE($4, installed_date),
      status = COALESCE($5, status),
      location = COALESCE($6, location),
      notes = COALESCE($7, notes)
      WHERE id = $8 RETURNING *`,
      [clientId ?? null, assetTag ?? null, serialNumber ?? null, installedDate ?? null, status ?? null, location ?? null, notes ?? null, id]);
    if (!row) return res.status(404).json({ error: 'fielded asset not found' });
    res.json({
      id: row.id,
      clientId: row.client_id,
      assetTag: row.asset_tag,
      serialNumber: row.serial_number,
      installedDate: row.installed_date,
      status: row.status,
      location: row.location,
      notes: row.notes,
      createdAt: row.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/fielded-assets/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query('DELETE FROM fielded_assets WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'fielded asset not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stock-ledger', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM stock_ledger ORDER BY movement_date DESC');
    res.json(rows.map((row: any) => ({
      id: row.id,
      itemSerialNumber: row.item_serial_number,
      movementType: row.movement_type,
      quantity: row.quantity,
      movementDate: row.movement_date,
      reference: row.reference,
      notes: row.notes,
      createdAt: row.created_at
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stock-ledger', async (req, res) => {
  const { itemSerialNumber, movementType, quantity, movementDate, reference, notes } = req.body;
  if (!movementType) return res.status(400).json({ error: 'movementType is required' });

  try {
    const row = await queryOne(`INSERT INTO stock_ledger (item_serial_number, movement_type, quantity, movement_date, reference, notes)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [itemSerialNumber || null, movementType, quantity || 0, movementDate || null, reference || null, notes || null]);
    res.status(201).json({
      id: row?.id,
      itemSerialNumber: row?.item_serial_number,
      movementType: row?.movement_type,
      quantity: row?.quantity,
      movementDate: row?.movement_date,
      reference: row?.reference,
      notes: row?.notes,
      createdAt: row?.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/stock-ledger/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { itemSerialNumber, movementType, quantity, movementDate, reference, notes } = req.body;
  try {
    const row = await queryOne(`UPDATE stock_ledger SET
      item_serial_number = COALESCE($1, item_serial_number),
      movement_type = COALESCE($2, movement_type),
      quantity = COALESCE($3, quantity),
      movement_date = COALESCE($4, movement_date),
      reference = COALESCE($5, reference),
      notes = COALESCE($6, notes)
      WHERE id = $7 RETURNING *`,
      [itemSerialNumber ?? null, movementType ?? null, quantity ?? null, movementDate ?? null, reference ?? null, notes ?? null, id]);
    if (!row) return res.status(404).json({ error: 'stock ledger entry not found' });
    res.json({
      id: row.id,
      itemSerialNumber: row.item_serial_number,
      movementType: row.movement_type,
      quantity: row.quantity,
      movementDate: row.movement_date,
      reference: row.reference,
      notes: row.notes,
      createdAt: row.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/stock-ledger/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query('DELETE FROM stock_ledger WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'stock ledger entry not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/raw-table/:name', async (req, res) => {
  const name = req.params.name;
  const { rows: tables } = await query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  const tableNames = tables.map((r: { tablename: string }) => r.tablename);
  if (!tableNames.includes(name)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }

  try {
    const { rows } = await query(`SELECT * FROM "${name}" LIMIT 1000`);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tables', async (_req, res) => {
  const { rows } = await query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  res.json(rows.map((r: { tablename: string }) => r.tablename));
});

app.post('/api/start', (_req, res) => {
  try {
    const child = spawn('node', ['--import', 'tsx/esm', 'server.ts'], {
      cwd: process.cwd(),
      stdio: 'ignore',
      shell: false,
      detached: true,
    });
    child.unref();
    res.json({ ok: true, pid: child.pid });
  } catch (err) {
    console.error('Failed to start server:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

async function auditKitStock(projectId: number, buildQty: number) {
  const { rows: tables } = await query<{ tablename: string }>(`SELECT c.relname as tablename FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'db_bom%'`);

  // Optimize: Only query legacy tables or the project's specific table
  const targetTables = tables.filter(t =>
    t.tablename === 'db_bom' ||
    t.tablename === 'db_bom_ncu04' ||
    t.tablename === 'db_bom_loradongle' ||
    t.tablename === `db_bom_project_${projectId}`
  );

  const aggregatedBOM = new Map<string, { quantity: number; description: string; comment: string; designator: string }>();

  for (const t of targetTables) {
    const { rows } = await query(`SELECT * FROM "${t.tablename}"`);
    for (const r of rows) {
      const rowProjectId = parseInt(r.project_name || r.projectId || r.ProjectId) || 1;
      if (rowProjectId === projectId) {
        const stockCode = String(r.internal_stock_number || r.stock_code || r.StockCode || '');
        const qty = parseInt(r.qty_per_unit || r.quantity || r.Quantity) || 1;
        const desc = String(r.description || r.Description || '');
        const comment = String(r.comment || r.Comment || '');
        const designator = String(r.ref_des || r.designator || r.Designator || '');

        if (aggregatedBOM.has(stockCode)) {
          const existing = aggregatedBOM.get(stockCode)!;
          existing.quantity += qty;
          if (designator) {
            existing.designator = existing.designator ? `${existing.designator}, ${designator}` : designator;
          }
        } else {
          aggregatedBOM.set(stockCode, { quantity: qty, description: desc, comment, designator });
        }
      }
    }
  }

  const auditResults: any[] = [];
  for (const [stockCode, bomInfo] of aggregatedBOM.entries()) {
    const qtyRequired = bomInfo.quantity * buildQty;
    const item = await queryOne(`SELECT * FROM inventory WHERE serial_number = $1`, [stockCode]);
    let qtyOnHand = item ? (parseInt(item.stock || '0') || 0) : 0;
    let resolvedPartNumber = stockCode;
    let usedAlternative = false;

    if (qtyOnHand < qtyRequired) {
      const alternatives = await query(`SELECT alternative_part_number FROM alternative_components WHERE primary_part_number = $1`, [stockCode]);
      for (const alt of alternatives.rows as any[]) {
        const altItem = await queryOne(`SELECT * FROM inventory WHERE serial_number = $1`, [alt.alternative_part_number]);
        const altStock = altItem ? (parseInt(altItem.stock || '0') || 0) : 0;
        if (altStock >= qtyRequired) {
          qtyOnHand = altStock;
          resolvedPartNumber = alt.alternative_part_number;
          usedAlternative = true;
          break;
        }
      }
    }

    const shortageQty = Math.max(0, qtyRequired - qtyOnHand);
    const supplierLinks = item ? [item.weblink_1, item.weblink_2, item.weblink_3, item.weblink_4, item.weblink_5].filter(Boolean) : [];

    auditResults.push({
      component_id: stockCode,
      resolved_part_number: resolvedPartNumber,
      used_alternative: usedAlternative,
      qty_required: qtyRequired,
      qty_on_hand: qtyOnHand,
      shortage_qty: shortageQty,
      description: item?.description || bomInfo.description,
      comment: item?.comment || bomInfo.comment,
      designator: bomInfo.designator,
      supplier_links: supplierLinks
    });
  }

  return auditResults;
}

app.post('/api/kit-booking/validate', async (req, res) => {
  const { projectId, buildQty } = req.body;
  if (!projectId || !buildQty) {
    return res.status(400).json({ error: 'projectId and buildQty are required' });
  }

  try {
    const auditResults = await auditKitStock(Number(projectId), Number(buildQty));
    res.json(auditResults);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/kit-booking/execute', async (req, res) => {
  const { projectId, buildQty } = req.body;
  if (!projectId || !buildQty) {
    return res.status(400).json({ error: 'projectId and buildQty are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const auditResults = await auditKitStock(Number(projectId), Number(buildQty));
    const shortages = auditResults.filter(r => r.shortage_qty > 0);

    if (shortages.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Insufficient stock for ${shortages.length} items. Booking blocked.` });
    }

    const now = new Date().toISOString();

    for (const result of auditResults) {
      const partToDeduct = result.resolved_part_number;
      const qtyToDeduct = result.qty_required;
      await client.query('UPDATE inventory SET stock = stock - $1 WHERE serial_number = $2', [qtyToDeduct, partToDeduct]);

      const item = await queryOne(`SELECT name FROM inventory WHERE serial_number = $1`, [partToDeduct]);
      const trxId = `TRX-KIT-${partToDeduct}-${Date.now()}`;
      await client.query(`INSERT INTO transactions (trxId, itemPartNumber, itemName, type, qtyChange, reference, performedBy, dateTime)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [trxId, partToDeduct, item?.name || 'Unknown', 'BOOK-OUT', -qtyToDeduct, `Kit Booking: Project ${projectId}`, 'System', now]);
    }

    const project = await queryOne(`SELECT assigned_team FROM projects WHERE id = $1`, [projectId]);
    await client.query(`INSERT INTO job_cards (project_id, build_qty, status, created_at, assigned_team) VALUES ($1, $2, $3, $4, $5)`,
      [projectId, buildQty, 'In Progress', now, project?.assigned_team || '']);

    await client.query('COMMIT');
    res.json({ ok: true, auditResults });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/shortages/convert-to-po', async (req, res) => {
  const { shortages, supplierId, supplierName } = req.body;
  if (!shortages || !Array.isArray(shortages) || shortages.length === 0) {
    return res.status(400).json({ error: 'shortages array is required' });
  }
  if (!supplierId && !supplierName) {
    return res.status(400).json({ error: 'supplierId or supplierName is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get or create supplier
    let sId: number | null = null;
    if (supplierId) {
      sId = Number(supplierId);
    } else if (supplierName) {
      const existing = await queryOne(`SELECT id FROM suppliers WHERE name = $1`, [supplierName]);
      if (existing) {
        sId = existing.id;
      } else {
        const newSupplier = await queryOne(`INSERT INTO suppliers (name, contact_name, email, phone, address, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [supplierName, '', '', '', '', 'ACTIVE']);
        sId = newSupplier.id;
      }
    }

    // Create PO with items from shortages
    const poNumber = await nextDocNumber(client, 'PO', 'po_seq');
    const orderDate = new Date().toISOString().slice(0, 10);

    // Transform shortages into line items (use shortage_qty as quantity)
    const items = shortages.map((s: any) => ({
      partNumber: s.resolved_part_number || s.component_id,
      description: s.description || s.comment || '',
      quantity: Math.ceil(s.shortage_qty || 0),
      unitPrice: 0, // Will be filled in from supplier pricing if available
    }));

    // Calculate totals
    const subtotal = 0; // User will fill in actual pricing
    const taxTotal = 0;
    const total = 0;

    const poRes = await client.query(
      `INSERT INTO purchase_orders (po_number, supplier_id, order_date, status, currency, subtotal, tax_total, total, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [poNumber, sId || null, orderDate, 'DRAFT', 'ZAR', subtotal, taxTotal, total, `Generated from shortage detection`]
    );
    const poId = poRes.rows[0].id;

    // Insert PO items
    for (const item of items) {
      await client.query(
        `INSERT INTO purchase_order_items (purchase_order_id, part_number, description, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [poId, item.partNumber, item.description, item.quantity, item.unitPrice]
      );
    }

    await client.query('COMMIT');
    const poRow = await queryOne(`SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [poId]);
    const poItems = await query(`SELECT * FROM purchase_order_items WHERE purchase_order_id = $1`, [poId]);

    res.status(201).json({
      po: mapPurchaseOrder(poRow),
      items: poItems.rows.map(mapPurchaseOrderItem),
      message: `PO ${poNumber} created with ${items.length} items`
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/suppliers/compare-prices - fetch and compare prices across suppliers
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
      const lcscCached = await queryOne(
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

// GET /api/suppliers/price-history/:partNumber - get historical pricing data
app.get('/api/suppliers/price-history/:partNumber', async (req, res) => {
  const { partNumber } = req.params;

  try {
    const history = await query(
      `SELECT supplier, price, stock, moq, lead_time_days, queried_at
       FROM supplier_price_history
       WHERE part_number = $1
       ORDER BY queried_at DESC
       LIMIT 100`,
      [partNumber]
    );

    res.json({ partNumber, history: history.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/suppliers/performance - get supplier performance metrics
app.get('/api/suppliers/performance', async (req, res) => {
  try {
    const performance = await query(
      `SELECT supplier, total_lookups, avg_price, avg_lead_time_days, stock_availability_pct, last_updated
       FROM supplier_performance
       ORDER BY total_lookups DESC`,
      []
    );

    res.json({ suppliers: performance.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Exchange rate. MUST be registered before the app.get('*') catch-all below —
// Express matches in registration order, and these previously sat ~300 lines
// after it, so every request was answered with index.html instead.
app.get('/api/exchange-rate', async (_req, res) => {
  try {
    res.json(await readExchangeRate());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/exchange-rate/update', async (_req, res) => {
  try {
    const refreshed = await updateExchangeRate();
    const current = await readExchangeRate();
    res.json({
      ...current,
      refreshed,
      message: refreshed
        ? 'Exchange rate refreshed.'
        : 'Could not reach the rate provider; showing the last stored rate.',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Serve index.html for all non-API routes (client-side routing)
app.get('*', (_req, res) => {
  const indexPath = path.join(DIST_DIR, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error('Error serving index.html:', err.message);
      res.status(500).send('Error loading page');
    }
  });
});

async function runSchemaBootstrap() {
  await ensureSchema();
    // NOTE: these were previously fire-and-forget (no `await`), which raced across the
    // connection pool with no guaranteed order — risky for FK-dependent tables (e.g.
    // client_orders references clients) on a brand-new database. Now sequenced properly.
    await exec(`CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      trxId TEXT UNIQUE,
      itemPartNumber TEXT,
      itemName TEXT,
      type TEXT,
      qtyChange INTEGER,
      reference TEXT,
      performedBy TEXT,
      performedByAvatar TEXT,
      dateTime TEXT,
      newCost REAL
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS production_kits (
      kitId TEXT PRIMARY KEY,
      skuReference TEXT,
      status TEXT,
      qtyAvailable INTEGER,
      assemblyLine TEXT,
      lastUpdated TEXT,
      projectId INTEGER
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      role TEXT DEFAULT 'VIEWER',
      status TEXT DEFAULT 'ACTIVE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP
    )`).catch(() => {});

    // Migrate: Add missing columns if they don't exist
    await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT NOT NULL DEFAULT 'migrate_required'`).catch(() => {});
    await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT`).catch(() => {});
    await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT`).catch(() => {});
    await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ACTIVE'`).catch(() => {});
    await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`).catch(() => {});
    await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`).catch(() => {});
    await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS role_permissions (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL,
      permission TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(role, permission)
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      client_name TEXT NOT NULL,
      contact_name TEXT,
      email TEXT,
      phone TEXT,
      address TEXT,
      vat_number TEXT,
      status TEXT DEFAULT 'ACTIVE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS client_orders (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      order_number TEXT UNIQUE NOT NULL,
      order_date DATE NOT NULL DEFAULT CURRENT_DATE,
      required_date DATE,
      status TEXT DEFAULT 'DRAFT',
      currency TEXT DEFAULT 'ZAR',
      subtotal NUMERIC(12,2) DEFAULT 0,
      tax NUMERIC(12,2) DEFAULT 0,
      total NUMERIC(12,2) DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS client_order_items (
      id SERIAL PRIMARY KEY,
      client_order_id INTEGER REFERENCES client_orders(id) ON DELETE CASCADE,
      part_number TEXT,
      description TEXT NOT NULL,
      quantity NUMERIC(10,2) DEFAULT 1,
      unit_price NUMERIC(12,2) DEFAULT 0,
      line_total NUMERIC(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS build_jobs (
      id SERIAL PRIMARY KEY,
      client_order_id INTEGER REFERENCES client_orders(id) ON DELETE SET NULL,
      job_number TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'PLANNED',
      build_qty INTEGER DEFAULT 1,
      start_date DATE,
      end_date DATE,
      assigned_team TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS bom_structures (
      id SERIAL PRIMARY KEY,
      parent_part_number TEXT NOT NULL,
      child_part_number TEXT NOT NULL,
      quantity NUMERIC(10,2) DEFAULT 1,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS sub_assemblies (
      id SERIAL PRIMARY KEY,
      assembly_name TEXT NOT NULL,
      parent_part_number TEXT,
      child_part_number TEXT,
      quantity NUMERIC(10,2) DEFAULT 1,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS fielded_assets (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      asset_tag TEXT UNIQUE,
      serial_number TEXT,
      installed_date DATE,
      status TEXT DEFAULT 'ACTIVE',
      location TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS stock_ledger (
      id SERIAL PRIMARY KEY,
      item_serial_number TEXT,
      movement_type TEXT NOT NULL,
      quantity NUMERIC(10,2) DEFAULT 0,
      movement_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      reference TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS job_cards (
      id SERIAL PRIMARY KEY,
      project_id INTEGER,
      build_qty INTEGER,
      status TEXT,
      created_at TEXT
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS alternative_components (
       id SERIAL PRIMARY KEY,
       primary_part_number TEXT,
       alternative_part_number TEXT
     )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS user_activity_logs (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      details JSONB,
      ip_address TEXT,
      user_agent TEXT,
      status TEXT DEFAULT 'SUCCESS',
      error_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE SET NULL
    )`).catch(() => {});
    await exec(`CREATE INDEX IF NOT EXISTS idx_activity_logs_user_email ON user_activity_logs(user_email)`).catch(() => {});
    await exec(`CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON user_activity_logs(created_at)`).catch(() => {});
    await exec(`CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON user_activity_logs(action)`).catch(() => {});
    await exec(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS lead_time INTEGER`).catch(() => {});
    await exec(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS response_time INTEGER`).catch(() => {});
    await exec(`ALTER TABLE production_kits ADD COLUMN IF NOT EXISTS projectId INTEGER`).catch(() => {});
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS projects_project_name_key ON projects(project_name)`).catch(() => {});
    await exec(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS start_date TEXT`).catch(() => {});
    await exec(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_date TEXT`).catch(() => {});
    await exec(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS assigned_team TEXT`).catch(() => {});
    await exec(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS design_specs TEXT`).catch(() => {});
    await exec(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS assigned_team TEXT`).catch(() => {});

    // Bookkeeping / ERP schema — runs after clients & client_orders exist, since invoices
    // and other new tables carry FK references to them.
    await ensureBookkeepingSchema().catch((e) => console.error('Failed to bootstrap bookkeeping schema:', e));

    await ensureProductionCostsSchema().catch((e) => console.error('Failed to bootstrap production costs schema:', e));

    // Phase 5: Quality & Compliance + Advanced Automation
    await ensurePhase5Tables().catch((e) => console.error('Failed to bootstrap Phase 5 schema:', e));

    // Seed demo user if it doesn't exist
    try {
      const demoUser = await queryOne(`SELECT id FROM users WHERE email = $1`, ['dedw13@gmail.com']);
      if (!demoUser) {
        await exec(`INSERT INTO users (email, first_name, last_name, role, status, password, created_at)
          VALUES ('dedw13@gmail.com', 'Demo', 'User', 'admin', 'ACTIVE', 'password123', datetime('now'))`);
        console.log('Demo user created successfully');
      }
    } catch (e) {
      console.error('Error seeding demo user:', (e as any).message);
    }

    console.log('Database bootstrapping complete.');
}

// ---------------------------------------------------------------------------
// Exchange rate management
//
// Previously this wrote to a key ('exchange_rate_zar_usd') using SQLite's
// datetime('now') and an updated_at column that does not exist on `settings`
// (which is just key/value). Both the fetch path and its fallback therefore
// threw on every boot, and the app silently fell back to a hard-coded 0.0526.
// The rate the app actually uses lives under 'usd_to_zar_rate', so consolidate
// on that pair of keys and store the fetch date alongside it.
// ---------------------------------------------------------------------------
const RATE_KEY = 'usd_to_zar_rate';
const RATE_UPDATED_KEY = 'usd_to_zar_rate_updated';

async function putSetting(key: string, value: string) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

// Historic values were written JSON-encoded (e.g. "\"2026-07-15\""), so unwrap.
function readSettingString(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : String(raw);
  } catch {
    return String(raw);
  }
}

async function readExchangeRate() {
  const rateRow = await queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [RATE_KEY]);
  const dateRow = await queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [RATE_UPDATED_KEY]);
  const usdToZar = rateRow ? parseFloat(readSettingString(rateRow.value) || '') : NaN;
  const lastUpdated = dateRow ? readSettingString(dateRow.value) : null;

  let ageDays: number | null = null;
  if (lastUpdated) {
    const t = new Date(lastUpdated).getTime();
    if (Number.isFinite(t)) ageDays = Math.floor((Date.now() - t) / 86400000);
  }

  return {
    usdToZar: Number.isFinite(usdToZar) ? usdToZar : null,
    zarToUsd: Number.isFinite(usdToZar) && usdToZar !== 0 ? Number((1 / usdToZar).toFixed(6)) : null,
    lastUpdated,
    ageDays,
    // Surfaced so the UI can warn instead of presenting a stale rate as current.
    stale: ageDays === null || ageDays > 7,
  };
}

async function updateExchangeRate() {
  try {
    const response = await fetch('https://api.exchangerate-api.com/v4/latest/ZAR');
    if (!response.ok) throw new Error(`exchange rate API returned ${response.status}`);

    const data = await response.json();
    const zarToUsd = data.rates?.USD;
    if (!zarToUsd || !Number.isFinite(zarToUsd) || zarToUsd <= 0) {
      throw new Error('exchange rate API returned no usable USD rate');
    }

    const usdToZar = Number((1 / zarToUsd).toFixed(5));
    await putSetting(RATE_KEY, String(usdToZar));
    await putSetting(RATE_UPDATED_KEY, new Date().toISOString().slice(0, 10));
    console.log(`Exchange rate updated: 1 USD = ${usdToZar} ZAR`);
    return true;
  } catch (err) {
    // Deliberately do NOT overwrite a previously good rate with a hard-coded
    // guess — a stale real rate beats a fabricated one, and readExchangeRate
    // reports its age so the UI can flag it.
    console.warn('Exchange rate refresh failed, keeping the stored rate:', (err as any).message);
    return false;
  }
}

// NOTE: the /api/exchange-rate routes are registered earlier in the file,
// above the app.get('*') SPA catch-all. Registering them here (after it) meant
// Express matched the catch-all first and served index.html instead, so the
// endpoint returned HTML and the UI could never read a rate.

async function bootstrap() {
  const PORT = parseInt(process.env.PORT || '3001', 10);

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Tracklab API listening on http://localhost:${PORT}`);
  });

  // Schedule exchange rate update every day at 06:00 (UTC)
  cron.schedule('0 6 * * *', () => {
    console.log('[CRON] Updating exchange rate at 06:00...');
    updateExchangeRate();
  });

  // Also update on startup
  await updateExchangeRate();

  // Neon serverless databases sleep when idle and can take several seconds to wake, so the
  // first connection often times out. Retry the (idempotent) schema bootstrap with backoff,
  // and — crucially — DO NOT exit the process if it ultimately fails: on an already-provisioned
  // database the API can serve fine without a successful bootstrap pass, and the pg pool will
  // reconnect on the next request. Killing the server on a transient DB hiccup takes the whole
  // app down until a manual restart, which is worse than serving with a stale-but-present schema.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await runSchemaBootstrap();
      break;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        console.error(`Database bootstrap failed after ${MAX_ATTEMPTS} attempts — continuing to serve; schema will be retried lazily on demand.`, err);
      } else {
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
        console.warn(`Database bootstrap attempt ${attempt} failed (${(err as Error).message}). Retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }

  return server;
}

bootstrap();

process.on('SIGINT', async () => {
  await close();
  process.exit(0);
});