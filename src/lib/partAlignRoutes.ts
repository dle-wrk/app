// Lining up every item's manufacturer part numbers, supplier part numbers
// and web links by slot (1 Mouser, 2 DigiKey, 3 LCSC, 4-5 other; see
// ./partAlign), with the manufacturer part number as each supplier lists it.
//
//   POST /api/inventory/part-align/run     start a check of every item (inventory.update)
//   GET  /api/inventory/part-align         the check's progress, and the items it would change
//   POST /api/inventory/part-align/apply   apply chosen items: {serials} (inventory.update)
//
// The check asks LCSC (by its part number), Mouser (by its part number, or
// the one in a Mouser link) and DigiKey (the part number in a DigiKey link,
// else by DigiKey's number) what the manufacturer part number is. Then, for
// Mouser and DigiKey where the item has nothing of theirs, it searches them
// for that manufacturer part number and takes their number and product page
// on an exact match only (LCSC can't be searched from a server: its slot
// fills from an LCSC number or link). One item at a time with pauses
// between calls; it keeps a proposal for each item whose slots would change. Nothing changes until the proposals are applied;
// applying skips an item that changed since it was checked.

import type { Express } from 'express';
import { pool, query, exec } from './db';
import { requirePermission } from './authRoutes';
import { NA, alignItem, linkSupplier, sameSlots, type ItemSlots, type SupplierFind } from './partAlign';
import { classifyPartNumberBySupplier, isUsablePartNumber, type SlotSupplier } from './partNumbers';
import { parseProductLink } from './productLink';
import { digikeyFind, fetchLcscDetail, mouserFind, mouserLookup, searchDigikey, type SupplierMatch } from './pricingRoutes';

const MAN = ['man_pn_1', 'man_pn_2', 'man_pn_3', 'man_pn_4', 'man_pn_5'];
const SUP = ['sup_pn_1', 'sup_pn_2', 'sup_pn_3', 'sup_pn_4', 'sup_pn_5'];
const WEB = ['weblink_1', 'weblink_2', 'weblink_3', 'weblink_4', 'weblink_5'];
const COLUMNS = [...MAN, ...SUP, ...WEB];

export async function ensurePartAlignSchema(run: (sql: string) => Promise<void> = exec): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS part_align_proposals (
    serial_number TEXT PRIMARY KEY,
    before JSONB NOT NULL,
    after JSONB NOT NULL,
    found JSONB,
    notes JSONB,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

export const slotsOf = (r: any): ItemSlots => ({
  man: MAN.map((c) => String(r[c] ?? '')), sup: SUP.map((c) => String(r[c] ?? '')), web: WEB.map((c) => String(r[c] ?? '')),
});

export interface AlignDeps {
  lcsc: (code: string) => Promise<string | null>;       // the manufacturer part number LCSC gives, or null
  mouser: (keyword: string) => Promise<{ mpn: string | null; mouserPn: string | null } | null>;
  digikey: (digikeyPn: string) => Promise<string | null>;
  /** Exact-match searches by manufacturer part number, for a supplier the item has nothing of. */
  mouserFind: (mpn: string) => Promise<SupplierMatch | null>;
  digikeyFind: (mpn: string) => Promise<SupplierMatch | null>;
  pause: (ms: number) => Promise<void>;
}

export const defaultAlignDeps: AlignDeps = {
  lcsc: async (code) => { const d = await fetchLcscDetail(code); return d?.result?.productModel ? String(d.result.productModel).trim() : null; },
  mouser: async (keyword) => { const d = await mouserLookup(keyword); return d ? { mpn: d.manufacturerPartNumber, mouserPn: d.supplierPartNumber } : null; },
  digikey: async (pn) => (await searchDigikey(pn))?.partNumber ?? null,
  mouserFind,
  digikeyFind,
  pause: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const errorOf = (err: any): SupplierFind => ({ status: 'error', message: String(err?.message || err).slice(0, 200) });

/** Asks each supplier about one item. */
export async function findForItem(slots: ItemSlots, deps: AlignDeps): Promise<Partial<Record<SlotSupplier, SupplierFind>>> {
  const all = [...slots.sup, ...slots.man];
  const numberOf = (s: SlotSupplier) => all.map((v) => v.trim()).find((v) => classifyPartNumberBySupplier(v) === s) ?? null;
  const linkOf = (s: SlotSupplier) => slots.web.find((u) => linkSupplier(u) === s) ?? null;
  const found: Partial<Record<SlotSupplier, SupplierFind>> = {};

  // LCSC: by its number, from a field or a link (LCSC's own, or JLCPCB's, whose parts are LCSC's).
  const lcscCode = numberOf('lcsc') ?? slots.web.map((u) => parseProductLink(u)?.lcscCode).find(Boolean) ?? null;
  if (!lcscCode) found.lcsc = { status: 'none' };
  else {
    try {
      const mpn = await deps.lcsc(lcscCode);
      // Its product page, for web link 3 when the item has no LCSC link.
      found.lcsc = mpn ? { status: 'found', mpn, supplierPn: lcscCode, link: `https://www.lcsc.com/product-detail/${encodeURIComponent(lcscCode)}.html` } : { status: 'none' };
    } catch (err) { found.lcsc = errorOf(err); }
    await deps.pause(400);
  }

  // DigiKey: the manufacturer part number is in its link; else ask by DigiKey's number.
  const dkLink = linkOf('digikey') ? parseProductLink(linkOf('digikey')!) : null;
  const dkPn = numberOf('digikey');
  if (dkLink?.mpn) found.digikey = { status: 'found', mpn: dkLink.mpn };
  else if (!dkPn) found.digikey = { status: 'none' };
  else {
    try {
      const mpn = await deps.digikey(dkPn);
      found.digikey = mpn ? { status: 'found', mpn } : { status: 'none' };
    } catch (err) { found.digikey = errorOf(err); }
    await deps.pause(600);
  }

  // Mouser: ask by its number, else by the part number in its link.
  const mLink = linkOf('mouser') ? parseProductLink(linkOf('mouser')!) : null;
  const keyword = numberOf('mouser') ?? mLink?.mpn ?? null;
  if (!keyword) found.mouser = { status: 'none' };
  else {
    try {
      const m = await deps.mouser(keyword);
      found.mouser = m?.mpn ? { status: 'found', mpn: m.mpn, supplierPn: m.mouserPn } : mLink?.manufacturer && mLink.mpn ? { status: 'found', mpn: mLink.mpn } : { status: 'none' };
    } catch (err) {
      // The link still says the part number when Mouser can't be asked.
      found.mouser = mLink?.manufacturer && mLink.mpn ? { status: 'found', mpn: mLink.mpn } : errorOf(err);
    }
    await deps.pause(2100); // Mouser allows 30 calls a minute
  }

  // Suppliers the item has nothing of: search them for the component's part
  // number (what a supplier gave, else one already in Mfr PN), exact match only.
  const mpn = (['lcsc', 'digikey', 'mouser'] as SlotSupplier[])
    .map((s) => { const f = found[s]; return f?.status === 'found' ? f.mpn?.trim() : ''; })
    .concat(slots.man.map((v) => v.trim()).filter((v) => isUsablePartNumber(v) && !classifyPartNumberBySupplier(v)))
    .find((v) => !!v);
  if (mpn) {
    const search = async (s: 'mouser' | 'digikey', find: (m: string) => Promise<SupplierMatch | null>, pauseMs: number) => {
      if (found[s]?.status !== 'none') return;
      try {
        const m = await find(mpn);
        if (m) found[s] = { status: 'found', mpn: m.mpn, supplierPn: m.supplierPn, link: m.url, discovered: true };
      } catch (err) { found[s] = errorOf(err); }
      await deps.pause(pauseMs);
    };
    await search('mouser', deps.mouserFind, 2100);
    await search('digikey', deps.digikeyFind, 600);
  }
  return found;
}

interface RunState { running: boolean; total: number; done: number; proposals: number; startedAt: string | null; finishedAt: string | null; by: string | null; error: string | null }
const state: RunState = { running: false, total: 0, done: 0, proposals: 0, startedAt: null, finishedAt: null, by: null, error: null };

export async function runAlignCheck(who: string, deps: AlignDeps = defaultAlignDeps): Promise<void> {
  if (state.running) throw new Error('A check is already running.');
  Object.assign(state, { running: true, total: 0, done: 0, proposals: 0, startedAt: new Date().toISOString(), finishedAt: null, by: who, error: null });
  try {
    const { rows } = await query(`SELECT serial_number, ${COLUMNS.join(', ')} FROM inventory WHERE deleted IS NOT TRUE ORDER BY serial_number`);
    state.total = rows.length;
    await query(`DELETE FROM part_align_proposals`);
    for (const r of rows) {
      const before = slotsOf(r);
      const found = await findForItem(before, deps);
      const { slots: after, notes } = alignItem(before, found);
      if (!sameSlots(before, after) || notes.length) {
        await query(
          `INSERT INTO part_align_proposals (serial_number, before, after, found, notes) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (serial_number) DO UPDATE SET before = EXCLUDED.before, after = EXCLUDED.after, found = EXCLUDED.found, notes = EXCLUDED.notes, checked_at = now()`,
          [r.serial_number, JSON.stringify(before), JSON.stringify(after), JSON.stringify(found), JSON.stringify(notes)]
        );
        state.proposals += 1;
      }
      state.done += 1;
    }
  } catch (err: any) {
    state.error = String(err?.message || err);
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
}

/** Applies the chosen proposals; an item that changed since it was checked is skipped. */
export async function applyProposals(serials: string[], who: string) {
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: Array<{ serialNumber: string; reason: string }> = [];
  try {
    await client.query('BEGIN');
    const { rows: proposals } = await client.query(`SELECT serial_number, before, after FROM part_align_proposals WHERE serial_number = ANY($1::text[])`, [serials]);
    const { rows: items } = await client.query(
      `SELECT serial_number, ${COLUMNS.join(', ')} FROM inventory WHERE serial_number = ANY($1::text[]) AND deleted IS NOT TRUE FOR UPDATE`, [serials]
    );
    const byItem = new Map(items.map((r: any) => [r.serial_number, r]));
    for (const p of proposals) {
      const item = byItem.get(p.serial_number);
      if (!item) { skipped.push({ serialNumber: p.serial_number, reason: 'The item no longer exists.' }); continue; }
      if (!sameSlots(slotsOf(item), p.before)) { skipped.push({ serialNumber: p.serial_number, reason: 'Changed since the check: run the check again.' }); continue; }
      const after: ItemSlots = p.after;
      const values = [...after.man, ...after.sup, ...after.web].map((v) => (v ? v : NA));
      await client.query(
        `UPDATE inventory SET ${COLUMNS.map((c, i) => `"${c}" = $${i + 2}`).join(', ')} WHERE serial_number = $1`,
        [p.serial_number, ...values]
      );
      await client.query(`DELETE FROM part_align_proposals WHERE serial_number = $1`, [p.serial_number]);
      await client.query(
        `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status) VALUES ($1, 'ALIGN_PART_NUMBERS', 'Item', $2, $3, 'SUCCESS')`,
        [who, p.serial_number, JSON.stringify({ before: p.before, after })]
      );
      applied.push(p.serial_number);
    }
    for (const s of serials) if (!proposals.some((p: any) => p.serial_number === s)) skipped.push({ serialNumber: s, reason: 'No proposal for it.' });
    await client.query('COMMIT');
    return { applied, skipped };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function registerPartAlignRoutes(app: Express, deps: AlignDeps = defaultAlignDeps): void {
  app.get('/api/inventory/part-align', async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT p.serial_number, i.name, p.before, p.after, p.found, p.notes, p.checked_at FROM part_align_proposals p
           LEFT JOIN inventory i ON i.serial_number = p.serial_number ORDER BY p.serial_number`
      );
      res.json({
        run: { ...state },
        proposals: rows.map((r: any) => ({ serialNumber: r.serial_number, name: r.name ?? null, before: r.before, after: r.after, found: r.found, notes: r.notes ?? [], checkedAt: r.checked_at })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/inventory/part-align/run', requirePermission('inventory.update'), (req: any, res) => {
    if (state.running) return res.status(409).json({ error: 'A check is already running.', run: { ...state } });
    void runAlignCheck(req.user?.email || 'unknown', deps).catch(() => {});
    res.status(202).json({ run: { ...state } });
  });

  app.post('/api/inventory/part-align/apply', requirePermission('inventory.update'), async (req: any, res) => {
    const serials = Array.isArray(req.body?.serials) ? req.body.serials.filter((s: unknown) => typeof s === 'string' && s.trim()).slice(0, 2000) : [];
    if (!serials.length) return res.status(400).json({ error: 'Say which items (serials) to apply.' });
    try {
      res.json(await applyProposals(serials, req.user?.email || 'unknown'));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
