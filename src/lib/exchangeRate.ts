// Exchange-rate surface extracted from server.ts. Owns storage, refresh, and
// two read-only endpoints. The stored ZAR-per-currency map is consumed by the
// pricing bulk-refresh (element14 quotes GBP, TME quotes PLN, EU stores quote
// EUR) — kept small and self-contained here so pricing can import it without
// pulling in unrelated server-boot concerns.
//
// The historic bug this module is careful about: settings values were written
// JSON-encoded in some code paths (e.g. "\"2026-07-15\""), so `readSettingString`
// unwraps them before parsing.

import type { Express } from 'express';
import { query, queryOne } from './db';

const RATE_KEY = 'usd_to_zar_rate';
const RATE_UPDATED_KEY = 'usd_to_zar_rate_updated';
// Extra currencies harvested from the same exchangerate-api response so the
// pricing bulk-refresh can convert element14 (GBP), TME (PLN), and EU-store
// (EUR) results without needing separate FX calls. USD is stored separately
// under RATE_KEY, so this list omits it.
const EXTRA_CURRENCIES = ['GBP', 'EUR', 'PLN', 'CAD', 'AUD', 'SGD'] as const;
const rateKeyFor = (cur: string) => `${cur.toLowerCase()}_to_zar_rate`;

async function putSetting(key: string, value: string) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

function readSettingString(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : String(raw);
  } catch {
    return String(raw);
  }
}

export async function readExchangeRate() {
  const rateRow = await queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [RATE_KEY]);
  const dateRow = await queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [RATE_UPDATED_KEY]);
  const usdToZar = rateRow ? parseFloat(readSettingString(rateRow.value) || '') : NaN;
  const lastUpdated = dateRow ? readSettingString(dateRow.value) : null;

  let ageDays: number | null = null;
  if (lastUpdated) {
    const t = new Date(lastUpdated).getTime();
    if (Number.isFinite(t)) ageDays = Math.floor((Date.now() - t) / 86400000);
  }

  // Missing rates are omitted rather than defaulted, so a downstream conversion
  // fails visibly instead of guessing.
  const extraRates: Record<string, number> = {};
  for (const cur of EXTRA_CURRENCIES) {
    const row = await queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [rateKeyFor(cur)]);
    const v = row ? parseFloat(readSettingString(row.value) || '') : NaN;
    if (Number.isFinite(v) && v > 0) extraRates[cur] = v;
  }
  if (Number.isFinite(usdToZar)) extraRates.USD = usdToZar;
  extraRates.ZAR = 1;

  return {
    usdToZar: Number.isFinite(usdToZar) ? usdToZar : null,
    zarToUsd: Number.isFinite(usdToZar) && usdToZar !== 0 ? Number((1 / usdToZar).toFixed(6)) : null,
    lastUpdated,
    ageDays,
    // Surfaced so the UI can warn instead of presenting a stale rate as current.
    stale: ageDays === null || ageDays > 7,
    // { GBP: 22.87, EUR: 19.42, PLN: 4.65, USD: 16.69, ZAR: 1, ... }
    ratesToZar: extraRates,
  };
}

export async function updateExchangeRate(): Promise<boolean> {
  try {
    const response = await fetch('https://api.exchangerate-api.com/v4/latest/ZAR');
    if (!response.ok) throw new Error(`exchange rate API returned ${response.status}`);

    const data: any = await response.json();
    const zarToUsd = data.rates?.USD;
    if (!zarToUsd || !Number.isFinite(zarToUsd) || zarToUsd <= 0) {
      throw new Error('exchange rate API returned no usable USD rate');
    }

    const usdToZar = Number((1 / zarToUsd).toFixed(5));
    await putSetting(RATE_KEY, String(usdToZar));
    await putSetting(RATE_UPDATED_KEY, new Date().toISOString().slice(0, 10));

    // Harvest additional currencies from the same response. This adds no API
    // traffic — the endpoint always returns a rates{} map. The API is anchored
    // to ZAR (see the URL), so data.rates[XXX] is XXX per ZAR; inverting gives
    // the ZAR-per-XXX rate we store.
    for (const cur of EXTRA_CURRENCIES) {
      const xxxPerZar = Number(data.rates?.[cur]);
      if (!Number.isFinite(xxxPerZar) || xxxPerZar <= 0) continue;
      const zarPerXxx = Number((1 / xxxPerZar).toFixed(5));
      await putSetting(rateKeyFor(cur), String(zarPerXxx));
    }

    console.log(`Exchange rate updated: 1 USD = ${usdToZar} ZAR (+ ${EXTRA_CURRENCIES.length} extra currencies)`);
    return true;
  } catch (err) {
    // Deliberately do NOT overwrite a previously good rate with a hard-coded
    // guess — a stale real rate beats a fabricated one, and readExchangeRate
    // reports its age so the UI can flag it.
    console.warn('Exchange rate refresh failed, keeping the stored rate:', (err as any).message);
    return false;
  }
}

export function registerExchangeRateRoutes(app: Express): void {
  // MUST be registered before the app.get('*') catch-all — Express matches in
  // registration order, and these previously sat ~300 lines after it, so every
  // request was answered with index.html instead.
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
}
