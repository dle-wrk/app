// Sales Builder: packages of lines to add to a sales order, quote or invoice
// (the rules: ./salesPackages). Admins and managers build them (the
// 'sales-packages' area needs orders.update / orders.delete, ./writeAccess);
// anyone signed in can list and expand them.
//
//   GET    /api/sales-packages                 every package, with totals, margin and warnings
//   POST   /api/sales-packages                 create
//   PUT    /api/sales-packages/:id             replace (lines included)
//   POST   /api/sales-packages/:id/duplicate   a copy, "<name> (copy)"
//   DELETE /api/sales-packages/:id             refused while another package uses it
//   GET    /api/sales-packages/:id/expand?currency=USD   the lines to put on an order

import type { Express } from 'express';
import { z } from 'zod';
import { exec, pool, query } from './db';
import { readExchangeRate } from './exchangeRate';
import {
  PACKAGE_LINE_KINDS, PackageError, expandPackage, inCurrency, packageTotals, wouldContainItself,
  type ExpandedLine, type PackageLine, type SalesPackage,
} from './salesPackages';

export async function ensureSalesPackagesSchema(run: (sql: string) => Promise<void> = exec): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS sales_packages (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    category TEXT,
    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    discount_pct NUMERIC(6,3) NOT NULL DEFAULT 0,
    notes TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by TEXT,
    updated_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await run(`CREATE TABLE IF NOT EXISTS sales_package_lines (
    id SERIAL PRIMARY KEY,
    package_id INTEGER NOT NULL REFERENCES sales_packages(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('item', 'product', 'service', 'package')),
    ref TEXT,
    description TEXT NOT NULL DEFAULT '',
    quantity NUMERIC(14,4) NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_rate_id INTEGER REFERENCES tax_rates(id) ON DELETE SET NULL
  )`);
  await run(`CREATE INDEX IF NOT EXISTS sales_package_lines_package_idx ON sales_package_lines (package_id, position)`);
}

const LineSchema = z.object({
  kind: z.enum(PACKAGE_LINE_KINDS),
  ref: z.string().trim().max(120).nullable().optional(),
  description: z.string().max(500).default(''),
  quantity: z.number().positive().max(1_000_000),
  unitPrice: z.number().min(0).max(1_000_000_000).default(0),
  taxRateId: z.number().int().nullable().optional(),
});
const PackageSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(80).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  clientId: z.number().int().nullable().optional(),
  discountPct: z.number().min(0).max(100).default(0),
  notes: z.string().max(2000).nullable().optional(),
  active: z.boolean().default(true),
  lines: z.array(LineSchema).min(1).max(200),
});
type PackageIn = z.infer<typeof PackageSchema>;

/** Every package with its lines. */
async function loadPackages(db: { query: typeof query } = { query }): Promise<Map<number, SalesPackage & { clientName: string | null; updatedAt: string; updatedBy: string | null }>> {
  const { rows: pkgs } = await db.query<any>(
    `SELECT p.*, c.client_name FROM sales_packages p LEFT JOIN clients c ON c.id = p.client_id ORDER BY p.name`);
  const { rows: lines } = await db.query<any>(`SELECT * FROM sales_package_lines ORDER BY package_id, position`);
  const out = new Map<number, any>();
  for (const p of pkgs) {
    out.set(p.id, {
      id: p.id, name: p.name, category: p.category, tags: Array.isArray(p.tags) ? p.tags : [], clientId: p.client_id,
      clientName: p.client_name ?? null, discountPct: Number(p.discount_pct) || 0, notes: p.notes, active: p.active,
      updatedAt: p.updated_at, updatedBy: p.updated_by, lines: [],
    });
  }
  for (const l of lines) {
    out.get(l.package_id)?.lines.push({
      kind: l.kind, ref: l.ref, description: l.description, quantity: Number(l.quantity),
      unitPrice: Number(l.unit_price), taxRateId: l.tax_rate_id,
    } as PackageLine);
  }
  return out;
}

/** What the items and products cost (rand per unit) and whether they may still be sold. */
async function loadCatalogue() {
  const rate = (await readExchangeRate()).usdToZar;
  const { rows: items } = await query<any>(
    `SELECT serial_number, name, status, bulk_price_zar, current_cost_dollar FROM inventory WHERE deleted IS NOT TRUE`);
  const { rows: products } = await query<any>(`SELECT model_number, description, production_cost FROM production_products`);
  const item = new Map<string, { name: string; status: string; cost: number | null }>();
  for (const i of items) {
    const zar = Number(i.bulk_price_zar) > 0 ? Number(i.bulk_price_zar) : Number(i.current_cost_dollar) > 0 && rate ? Number(i.current_cost_dollar) * rate : null;
    item.set(String(i.serial_number).toUpperCase(), { name: i.name, status: String(i.status || 'ACTIVE').toUpperCase(), cost: zar });
  }
  const product = new Map<string, { name: string; cost: number | null }>();
  for (const p of products) product.set(String(p.model_number).toUpperCase(), { name: p.description, cost: Number(p.production_cost) > 0 ? Number(p.production_cost) : null });
  return { item, product };
}

function costOf(cat: Awaited<ReturnType<typeof loadCatalogue>>) {
  return (l: ExpandedLine): number | null => {
    const key = String(l.partNumber ?? '').toUpperCase();
    if (l.kind === 'item') return cat.item.get(key)?.cost ?? null;
    if (l.kind === 'product') return cat.product.get(key)?.cost ?? null;
    return null;
  };
}

/** Items in the lines that shouldn't be sold any more, or no longer exist. */
function warningsFor(lines: ExpandedLine[], cat: Awaited<ReturnType<typeof loadCatalogue>>): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const key = String(l.partNumber ?? '').toUpperCase();
    if (l.kind === 'item') {
      const i = cat.item.get(key);
      if (!i) out.push(`${l.partNumber} is no longer in Items & Inventory.`);
      else if (['INACTIVE', 'DO NOT USE', 'DISCONTINUED'].includes(i.status)) out.push(`${l.partNumber} is marked ${i.status === 'DO NOT USE' ? 'Do Not Use' : i.status.charAt(0) + i.status.slice(1).toLowerCase()}.`);
    } else if (l.kind === 'product' && !cat.product.has(key)) {
      out.push(`${l.partNumber} is no longer in Production Costs.`);
    }
  }
  return [...new Set(out)];
}

/** Checks a package before it is saved: what it refers to exists, and it doesn't contain itself. */
async function problemsWith(input: PackageIn, id: number | null): Promise<string | null> {
  const all = await loadPackages();
  const cat = await loadCatalogue();
  for (const [n, l] of input.lines.entries()) {
    const ref = (l.ref ?? '').trim();
    const where = `Line ${n + 1}`;
    if (l.kind === 'service') { if (!l.description.trim()) return `${where}: a service needs a description.`; continue; }
    if (!ref) return `${where}: choose the ${l.kind === 'package' ? 'package' : l.kind === 'product' ? 'product' : 'item'}.`;
    if (l.kind === 'item' && !cat.item.has(ref.toUpperCase())) return `${where}: ${ref} isn't in Items & Inventory.`;
    if (l.kind === 'product' && !cat.product.has(ref.toUpperCase())) return `${where}: ${ref} isn't in Production Costs.`;
    if (l.kind === 'package') {
      const child = Number(ref);
      if (!all.has(child)) return `${where}: that package no longer exists.`;
      if (child === id) return `${where}: a package can't contain itself.`;
    }
  }
  if (wouldContainItself(id, input.lines.map((l) => ({ ...l, ref: l.ref ?? null, taxRateId: l.taxRateId ?? null })), all)) {
    return 'That would put this package inside itself (through another package).';
  }
  if (input.clientId != null) {
    const { rows } = await query(`SELECT 1 FROM clients WHERE id = $1`, [input.clientId]);
    if (!rows.length) return 'That client no longer exists.';
  }
  return null;
}

async function savePackage(input: PackageIn, id: number | null, who: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vals = [input.name, input.category || null, JSON.stringify(input.tags), input.clientId ?? null, input.discountPct, input.notes || null, input.active, who];
    let pid = id;
    if (pid === null) {
      const { rows } = await client.query(
        `INSERT INTO sales_packages (name, category, tags, client_id, discount_pct, notes, active, created_by, updated_by)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $8) RETURNING id`, vals);
      pid = rows[0].id;
    } else {
      const { rowCount } = await client.query(
        `UPDATE sales_packages SET name = $1, category = $2, tags = $3::jsonb, client_id = $4, discount_pct = $5, notes = $6,
           active = $7, updated_by = $8, updated_at = now() WHERE id = $9`, [...vals, pid]);
      if (!rowCount) throw Object.assign(new Error('Package not found'), { status: 404 });
      await client.query(`DELETE FROM sales_package_lines WHERE package_id = $1`, [pid]);
    }
    for (const [i, l] of input.lines.entries()) {
      await client.query(
        `INSERT INTO sales_package_lines (package_id, position, kind, ref, description, quantity, unit_price, tax_rate_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [pid, i, l.kind, l.kind === 'service' ? null : (l.ref ?? '').trim(), l.description, l.quantity, l.kind === 'package' ? 0 : l.unitPrice, l.taxRateId ?? null]);
    }
    await client.query('COMMIT');
    return pid!;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const sendError = (res: any, err: any) => {
  if (err?.code === '23505') return res.status(409).json({ error: 'A package with that name already exists.' });
  res.status(err?.status || 500).json({ error: err?.message || 'Failed' });
};

export function registerSalesPackagesRoutes(app: Express): void {
  app.get('/api/sales-packages', async (_req, res) => {
    try {
      const [all, cat] = await Promise.all([loadPackages(), loadCatalogue()]);
      const out = [...all.values()].map((p) => {
        try {
          const lines = expandPackage(p.id, all);
          return { ...p, totals: packageTotals(lines, costOf(cat)), warnings: warningsFor(lines, cat), error: null };
        } catch (err: any) {
          return { ...p, totals: null, warnings: [], error: err instanceof PackageError ? err.message : String(err?.message || err) };
        }
      });
      res.json(out);
    } catch (err) { sendError(res, err); }
  });

  app.post('/api/sales-packages', async (req: any, res) => {
    const parsed = PackageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Check the package details.' });
    try {
      const problem = await problemsWith(parsed.data, null);
      if (problem) return res.status(400).json({ error: problem });
      res.status(201).json({ id: await savePackage(parsed.data, null, req.user?.email || 'unknown') });
    } catch (err) { sendError(res, err); }
  });

  app.put('/api/sales-packages/:id', async (req: any, res) => {
    const id = Number(req.params.id);
    const parsed = PackageSchema.safeParse(req.body);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad package id' });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Check the package details.' });
    try {
      const problem = await problemsWith(parsed.data, id);
      if (problem) return res.status(400).json({ error: problem });
      res.json({ id: await savePackage(parsed.data, id, req.user?.email || 'unknown') });
    } catch (err) { sendError(res, err); }
  });

  app.post('/api/sales-packages/:id/duplicate', async (req: any, res) => {
    const id = Number(req.params.id);
    try {
      const all = await loadPackages();
      const p = all.get(id);
      if (!p) return res.status(404).json({ error: 'Package not found' });
      const names = new Set([...all.values()].map((x) => x.name.toLowerCase()));
      let name = `${p.name} (copy)`;
      for (let n = 2; names.has(name.toLowerCase()); n++) name = `${p.name} (copy ${n})`;
      const newId = await savePackage({ ...p, name, clientId: p.clientId, category: p.category, notes: p.notes, lines: p.lines.map((l) => ({ ...l, ref: l.ref })) } as PackageIn, null, req.user?.email || 'unknown');
      res.status(201).json({ id: newId, name });
    } catch (err) { sendError(res, err); }
  });

  app.delete('/api/sales-packages/:id', async (req, res) => {
    const id = Number(req.params.id);
    try {
      const { rows: users } = await query<any>(
        `SELECT DISTINCT p.name FROM sales_package_lines l JOIN sales_packages p ON p.id = l.package_id
          WHERE l.kind = 'package' AND l.ref = $1`, [String(id)]);
      if (users.length) return res.status(409).json({ error: `Used inside ${users.map((u) => `"${u.name}"`).join(', ')}: take it out of ${users.length === 1 ? 'that package' : 'those'} first, or retire it instead.` });
      const { rowCount } = await query(`DELETE FROM sales_packages WHERE id = $1`, [id]);
      if (!rowCount) return res.status(404).json({ error: 'Package not found' });
      res.json({ ok: true });
    } catch (err) { sendError(res, err); }
  });

  app.get('/api/sales-packages/:id/expand', async (req, res) => {
    const id = Number(req.params.id);
    const currency = String(req.query.currency || 'ZAR').toUpperCase().slice(0, 3);
    try {
      const [all, cat] = await Promise.all([loadPackages(), loadCatalogue()]);
      const p = all.get(id);
      if (!p) return res.status(404).json({ error: 'Package not found' });
      let lines = expandPackage(id, all);
      const warnings = warningsFor(lines, cat);
      let rate: number | null = null;
      if (currency !== 'ZAR') {
        rate = (await readExchangeRate()).ratesToZar[currency] ?? null;
        if (!rate) return res.status(400).json({ error: `No exchange rate for ${currency}, so the rand prices can't be converted.` });
        lines = inCurrency(lines, rate);
      }
      res.json({ id, name: p.name, notes: p.notes, currency, zarPerUnit: rate, lines, warnings, active: p.active });
    } catch (err: any) {
      if (err instanceof PackageError) return res.status(400).json({ error: err.message });
      sendError(res, err);
    }
  });
}
