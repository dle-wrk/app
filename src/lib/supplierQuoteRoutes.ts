// Quotes for supplier order files (BOM Audit and restock): each line priced
// at each supplier it has a part number for, at the quantity, in rand.
//
//   POST /api/supplier-quotes        {lines: [{stockCode, supPns, qty}]} → 202 {id}
//   GET  /api/supplier-quotes/:id    progress, then {lines: [{stockCode, qty, quotes, best}]}
//
// Runs in the background with pauses between supplier calls (Mouser allows
// 30 a minute) and counts against each supplier's daily limit. Each
// supplier's price ladder is kept a day in pricing_cache (provider
// 'ladder:<supplier>'), so asking again, or for other quantities, is quick.
// The cheapest choice itself: ./supplierQuotes.

import type { Express } from 'express';
import { randomBytes } from 'crypto';
import { query, queryOne } from './db';
import { readExchangeRate } from './exchangeRate';
import type { SlotSupplier } from './partNumbers';
import { ORDER_SUPPLIERS, supplierNumberFor } from './supplierBom';
import { bestPackaging, cheapestSupplier, type Ladder, type LineQuotes } from './supplierQuotes';
import { countPricingCall, digikeyLadder, lcscLadder, mouserLadder, pricingCallAllowed } from './pricingRoutes';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAUSE_MS: Record<SlotSupplier, number> = { mouser: 2100, digikey: 600, lcsc: 400 };
const MAX_LINES = 500;

export interface QuoteDeps {
  fetchLadder: (supplier: SlotSupplier, pn: string) => Promise<Ladder | null>;
  cached: (supplier: SlotSupplier, pn: string) => Promise<{ ladder: Ladder | null } | null>;
  remember: (supplier: SlotSupplier, pn: string, ladder: Ladder | null) => Promise<void>;
  allowed: (supplier: SlotSupplier) => Promise<boolean>;
  counted: (supplier: SlotSupplier) => Promise<void>;
  ratesToZar: () => Promise<Record<string, number>>;
  pause: (ms: number) => Promise<void>;
}

export const defaultQuoteDeps: QuoteDeps = {
  fetchLadder: (s, pn) => (s === 'mouser' ? mouserLadder(pn) : s === 'digikey' ? digikeyLadder(pn) : lcscLadder(pn)),
  cached: async (s, pn) => {
    const row = await queryOne<{ data: string; created_at: string }>(
      `SELECT data, created_at FROM pricing_cache WHERE provider = $1 AND part_number = $2 AND qty = 0`, [`ladder2:${s}`, pn.toUpperCase()]);
    if (!row || Date.now() - new Date(row.created_at).getTime() > DAY_MS) return null;
    try { return { ladder: JSON.parse(row.data) }; } catch { return null; }
  },
  remember: async (s, pn, ladder) => {
    await query(
      `INSERT INTO pricing_cache (provider, part_number, qty, data, created_at) VALUES ($1, $2, 0, $3, now())
       ON CONFLICT (provider, part_number, qty) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
      [`ladder2:${s}`, pn.toUpperCase(), JSON.stringify(ladder)]);
  },
  allowed: (s) => (s === 'lcsc' ? Promise.resolve(true) : pricingCallAllowed(s)),
  counted: (s) => (s === 'lcsc' ? Promise.resolve() : countPricingCall(s)),
  ratesToZar: async () => (await readExchangeRate()).ratesToZar,
  pause: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface QuoteLineIn { stockCode: string; supPns?: string[]; qty: number }
export interface QuoteLineOut { stockCode: string; qty: number; quotes: LineQuotes; best: SlotSupplier | null }

interface Job { id: string; by: string; total: number; done: number; finished: boolean; error: string | null; lines: QuoteLineOut[]; startedAt: number }
const jobs = new Map<string, Job>();

/** Prices every line at each supplier it has a number for; one call per supplier part number. */
export async function quoteLines(lines: QuoteLineIn[], deps: QuoteDeps, progress: (done: number, total: number) => void = () => {}): Promise<QuoteLineOut[]> {
  const rates = await deps.ratesToZar();
  // Each supplier part number once, however many lines use it.
  const wanted = new Map<string, { supplier: SlotSupplier; pn: string }>();
  for (const l of lines) for (const { key } of ORDER_SUPPLIERS) {
    const pn = supplierNumberFor(l.supPns, key);
    if (pn) wanted.set(`${key}:${pn.toUpperCase()}`, { supplier: key, pn });
  }
  const ladders = new Map<string, Ladder | null | { error: string }>();
  let done = 0;
  for (const [k, { supplier, pn }] of wanted) {
    try {
      const hit = await deps.cached(supplier, pn);
      if (hit) ladders.set(k, hit.ladder);
      else if (!(await deps.allowed(supplier))) ladders.set(k, { error: `Today's ${supplier} lookups are used up` });
      else {
        await deps.counted(supplier);
        const ladder = await deps.fetchLadder(supplier, pn);
        ladders.set(k, ladder);
        await deps.remember(supplier, pn, ladder).catch(() => {});
        await deps.pause(PAUSE_MS[supplier]);
      }
    } catch (err: any) {
      ladders.set(k, { error: String(err?.message || err).slice(0, 160) });
    }
    progress(++done, wanted.size);
  }
  return lines.map((l) => {
    const quotes: LineQuotes = {};
    for (const { key, label } of ORDER_SUPPLIERS) {
      const pn = supplierNumberFor(l.supPns, key);
      if (!pn) continue;
      const ladder = ladders.get(`${key}:${pn.toUpperCase()}`);
      if (!ladder) { quotes[key] = { error: `${label} doesn't list ${pn}` }; continue; }
      if ('error' in ladder) { quotes[key] = ladder; continue; }
      const rate = rates[ladder.currency];
      if (!rate) { quotes[key] = { error: `No exchange rate for ${ladder.currency}` }; continue; }
      quotes[key] = bestPackaging(ladder, l.qty, rate) ?? { error: `${label} gave no price` };
    }
    return { stockCode: l.stockCode, qty: l.qty, quotes, best: cheapestSupplier(quotes) };
  });
}

export function registerSupplierQuoteRoutes(app: Express, deps: QuoteDeps = defaultQuoteDeps): void {
  app.post('/api/supplier-quotes', (req: any, res) => {
    const raw = Array.isArray(req.body?.lines) ? req.body.lines : null;
    if (!raw?.length) return res.status(400).json({ error: 'Send the lines to price.' });
    if (raw.length > MAX_LINES) return res.status(400).json({ error: `At most ${MAX_LINES} lines at a time.` });
    const lines: QuoteLineIn[] = raw
      .map((l: any) => ({ stockCode: String(l?.stockCode ?? '').slice(0, 100), supPns: Array.isArray(l?.supPns) ? l.supPns.slice(0, 5).map((v: any) => String(v ?? '').slice(0, 100)) : [], qty: Math.floor(Number(l?.qty)) }))
      .filter((l: QuoteLineIn) => l.stockCode && l.qty > 0 && l.qty <= 10_000_000);
    if (!lines.length) return res.status(400).json({ error: 'No line has a quantity to price.' });
    // Forget finished jobs older than an hour.
    for (const [id, j] of jobs) if (j.finished && Date.now() - j.startedAt > 60 * 60 * 1000) jobs.delete(id);
    const job: Job = { id: randomBytes(8).toString('hex'), by: req.user?.email || 'unknown', total: 0, done: 0, finished: false, error: null, lines: [], startedAt: Date.now() };
    jobs.set(job.id, job);
    quoteLines(lines, deps, (done, total) => { job.done = done; job.total = total; })
      .then((out) => { job.lines = out; })
      .catch((err) => { job.error = String(err?.message || err); })
      .finally(() => { job.finished = true; });
    res.status(202).json({ id: job.id });
  });

  app.get('/api/supplier-quotes/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'That price check has expired: run it again.' });
    res.json({ done: job.done, total: job.total, finished: job.finished, error: job.error, lines: job.finished ? job.lines : [] });
  });
}
