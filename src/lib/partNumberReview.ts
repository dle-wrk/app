// Part-number review: what is wrong with items' part-number fields, and the
// fixes anyone allowed to change inventory can apply from the app.
//
//   GET  /api/inventory/part-number-review       the issues, with the fix for each
//   POST /api/inventory/part-number-review/fix   apply fixes (inventory.update)
//
// The rules are those of ./partNumbers. A fix is only ever one of the fixes
// the review itself offers for the item as it is now: the server works the
// review out again, under a row lock, and applies a requested fix only if it
// still matches. So the endpoint can't be used to rewrite a real part
// number, and a fix whose value changed in the meantime is skipped.
//
// Fixes write inventory (the data-version middleware tells open tabs to
// reload) and leave a line per change in user_activity_logs.

import type { Express } from 'express';
import type { PoolClient } from 'pg';
import { pool, query } from './db';
import { requirePermission } from './authRoutes';
import { roleCan } from './permissions';
import {
  NONE_MARKERS, PART_NUMBER_FIELDS, PLACEHOLDER_PART_NUMBERS, SUPPLIER_SLOTS, arrangeSupplierSlots,
  classifyPartNumberBySupplier, looksLikeName, normalSlot, pickPartNumbers,
  type PartNumberField,
} from './partNumbers';

export type IssueKind = 'supplier_name' | 'number_in_supplier_field' | 'supplier_number_in_mfr' | 'placeholder' | 'lcsc_extra_text' | 'wrong_slot' | 'not_a_part_number' | 'held_back' | 'swapped' | 'no_part_number';
export type FixAction = 'move_to_supplier' | 'clear' | 'set' | 'arrange_slots' | 'move_to_slot' | 'supplier_from_number';

export interface PartNumberIssue {
  kind: IssueKind;
  serialNumber: string;
  name: string | null;
  /** The part-number field concerned, when there is one. */
  field: PartNumberField | null;
  /** That field's current value (or, for held_back, the part number looked up). */
  value: string | null;
  /** What the fix does, or null when it needs a person. */
  fix: { action: FixAction; value?: string } | null;
  note: string;
  /** wrong_slot: the supplier part numbers now (sup_pn_1..5) and after the fix. */
  slots?: { from: string[]; to: string[] | null };
}

const SUP_FIELDS = ['sup_pn_1', 'sup_pn_2', 'sup_pn_3', 'sup_pn_4', 'sup_pn_5'] as const;
const MAN_FIELDS = ['man_pn_1', 'man_pn_2', 'man_pn_3', 'man_pn_4', 'man_pn_5'] as const;
const OWN_SLOT: Record<string, number> = { mouser: 0, digikey: 1, lcsc: 2 };
const SUPPLIER_LABEL: Record<string, string> = { mouser: 'Mouser', digikey: 'DigiKey', lcsc: 'LCSC' };

/**
 * Whose supplier number a manufacturer field holds: LCSC (C123456), DigiKey
 * (…-ND) and Mouser (three digits and a hyphen: 652-SRR1210-100M), per
 * classifyPartNumberBySupplier.
 */
function supplierNumberIn(value: string): string | null {
  return classifyPartNumberBySupplier(value);
}
const slotName = (i: number) => `SupPN${i + 1} (${SUPPLIER_SLOTS[i].label})`;

/** "C365814 (LCSC): SupPN2 (DigiKey) → SupPN3 (LCSC)", one per number that moves. */
function describeMoves(from: string[], to: string[]): string {
  const moves: string[] = [];
  to.forEach((v, i) => {
    if (!v || from[i] === v) return;
    const was = from.indexOf(v);
    const whose = classifyPartNumberBySupplier(v);
    moves.push(`${v}${whose ? ` (${SUPPLIER_SLOTS.find((s) => s.supplier === whose)!.label})` : ''}: ${slotName(was)} → ${slotName(i)}`);
  });
  return moves.join('; ');
}

export interface ReviewRow {
  serial_number: string;
  name?: string | null;
  supplier?: string | null;
  last_status?: string | null;
  flagged_part_number?: string | null;
  flagged_usd?: string | number | null;
  flagged_provider?: string | null;
  flagged_match?: string | null;
  [field: string]: any;
}

const FIELD_LABEL: Record<PartNumberField, string> = {
  man_pn_1: 'ManPN1', man_pn_2: 'ManPN2', man_pn_3: 'ManPN3', man_pn_4: 'ManPN4', man_pn_5: 'ManPN5',
  sup_pn_1: 'SupPN1', sup_pn_2: 'SupPN2', sup_pn_3: 'SupPN3', sup_pn_4: 'SupPN4', sup_pn_5: 'SupPN5',
};
export const fieldLabel = (f: PartNumberField) => FIELD_LABEL[f];

const STOCK_CODE = /^[A-Z]{2,4}-\d{2,4}$/;
const LCSC_WITH_TEXT = /^(C\d+)\s+\S/i;

/** The issues of each item, in stock-code order. */
export function reviewItems(rows: ReviewRow[]): PartNumberIssue[] {
  const issues: PartNumberIssue[] = [];
  for (const r of rows) {
    const base = { serialNumber: r.serial_number, name: r.name ?? null };
    const supplierField = String(r.supplier ?? '').trim();
    // The supplier the item will have once its earlier fixes are applied.
    let supplier = supplierField && !NONE_MARKERS.includes(supplierField.toUpperCase()) ? supplierField : '';
    // A part number in the Supplier field (the item form used to mix them up):
    // the item gets that supplier's name instead.
    const supplierFieldWhose = classifyPartNumberBySupplier(supplierField);
    if (supplierFieldWhose) supplier = SUPPLIER_LABEL[supplierFieldWhose];

    for (const field of PART_NUMBER_FIELDS) {
      const value = String(r[field] ?? '').trim();
      if (!value) continue;
      const upper = value.toUpperCase();
      const lcsc = value.match(LCSC_WITH_TEXT);
      if (lcsc) {
        issues.push({ ...base, kind: 'lcsc_extra_text', field, value, fix: { action: 'set', value: lcsc[1].toUpperCase() },
          note: `An LCSC part number followed by other text. LCSC can only be asked by the number on its own: ${lcsc[1].toUpperCase()}.` });
      } else if (NONE_MARKERS.includes(upper)) {
        continue; // the app's own "none" marker: harmless
      } else if (PLACEHOLDER_PART_NUMBERS.includes(upper)) {
        issues.push({ ...base, kind: 'placeholder', field, value, fix: { action: 'clear' },
          note: 'A placeholder, not a part number. Clearing it changes nothing else.' });
      } else if (looksLikeName(value) && field.startsWith('sup_pn_')) {
        if (!supplier) {
          supplier = value;
          issues.push({ ...base, kind: 'supplier_name', field, value, fix: { action: 'move_to_supplier' },
            note: `A supplier name in a supplier part-number field (where the item form used to keep the supplier). It moves to the item's Supplier field.` });
        } else {
          issues.push({ ...base, kind: 'supplier_name', field, value, fix: { action: 'clear' },
            note: supplier.toUpperCase() === upper
              ? `Already the item's supplier (${supplier}). Clearing removes the copy.`
              : `A supplier name; the item's supplier is ${supplier}, so this is cleared. Put ${value}'s part number here if you buy it there too.` });
        }
      } else if (looksLikeName(value)) {
        issues.push({ ...base, kind: 'not_a_part_number', field, value, fix: null,
          note: 'No digits, so it is not used for pricing. Leave it if it is the real model code; otherwise replace it with the manufacturer part number.' });
      }
    }

    // Supplier numbers in the Supplier field or in manufacturer fields: to
    // their supplier's slot (a free 4-5 when it is taken), or just cleared
    // when the item has them in a supplier slot already.
    const supNow = SUP_FIELDS.map((f) => String(r[f] ?? '').trim());
    const manNow = MAN_FIELDS.map((f) => String(r[f] ?? '').trim());
    // A slot is free when it is empty or N/A; a supplier's own slot (1-3) is
    // also free when all it holds is a copy of the item's manufacturer part
    // number (SRR1210-100M in Mouser's slot): that is kept in Mfr PN anyway.
    const isMfrCopy = (v: string) => !classifyPartNumberBySupplier(v) && manNow.some((m) => m && m.toUpperCase() === v.toUpperCase());
    const taken = new Set(supNow.map((v, i) => (normalSlot(v) && !(i < 3 && isMfrCopy(v)) ? i : -1)).filter((i) => i >= 0));
    const adding: string[] = [];
    const inSupplierSlots = (v: string) => [...supNow, ...adding].some((x) => x && x.toUpperCase() === v.toUpperCase());
    const claim = (whose: string): number | null => {
      for (const i of [OWN_SLOT[whose], 3, 4]) if (!taken.has(i)) { taken.add(i); return i; }
      return null;
    };
    if (supplierFieldWhose) {
      const name = SUPPLIER_LABEL[supplierFieldWhose];
      const slot = inSupplierSlots(supplierField) ? null : claim(supplierFieldWhose);
      if (slot !== null) adding.push(supplierField);
      issues.push({ ...base, kind: 'number_in_supplier_field', field: null, value: supplierField,
        fix: { action: 'supplier_from_number', value: JSON.stringify({ supplier: name, slot: slot === null ? null : SUP_FIELDS[slot] }) },
        note: slot === null
          ? `A ${name} part number in the Supplier field; the item has it in a supplier slot already. The fix sets Supplier to ${name}.`
          : `A ${name} part number in the Supplier field. The fix sets Supplier to ${name} and puts the number in SupPN${slot + 1}.` });
    }
    MAN_FIELDS.forEach((field, n) => {
      const value = manNow[n];
      if (!value) return;
      const whose = supplierNumberIn(value);
      if (!whose) return;
      const name = SUPPLIER_LABEL[whose];
      if (inSupplierSlots(value)) {
        issues.push({ ...base, kind: 'supplier_number_in_mfr', field, value, fix: { action: 'clear' },
          note: `A ${name} part number, not the manufacturer's. The item has it in a supplier slot already, so the fix clears this copy.` });
        return;
      }
      const slot = claim(whose);
      if (slot === null) {
        issues.push({ ...base, kind: 'supplier_number_in_mfr', field, value, fix: null,
          note: `A ${name} part number, not the manufacturer's, and every supplier slot is full. Open the item to sort it out.` });
        return;
      }
      adding.push(value);
      issues.push({ ...base, kind: 'supplier_number_in_mfr', field, value, fix: { action: 'move_to_slot', value: SUP_FIELDS[slot] },
        note: `A ${name} part number, not the manufacturer's. The fix moves it to SupPN${slot + 1}${slot === OWN_SLOT[whose] ? ` (${name})` : ' (that supplier\'s slot is taken)'}.` });
    });

    // Supplier part numbers in another supplier's slot (1 Mouser, 2 DigiKey,
    // 3 LCSC): one fix per item moves them all. Offered once the item's
    // other supplier-field fixes are done, so two fixes never touch one field.
    const from = SUP_FIELDS.map((f) => String(r[f] ?? '').trim());
    const to = arrangeSupplierSlots(from);
    if (to === null || to.some((v, i) => v !== normalSlot(from[i]))) {
      const pending = issues.some((i) => i.serialNumber === r.serial_number && i.fix
        && (i.field?.startsWith('sup_pn_') || i.fix.action === 'move_to_slot' || i.fix.action === 'supplier_from_number'));
      if (!to) {
        issues.push({ ...base, kind: 'wrong_slot', field: null, value: from.filter(Boolean).join(', '), fix: null, slots: { from, to: null },
          note: 'Supplier part numbers are in the wrong slots (1 Mouser, 2 DigiKey, 3 LCSC, 4-5 other), and there is no free slot to move them to. Open the item to sort them out.' });
      } else {
        const moves = describeMoves(from, to);
        issues.push({ ...base, kind: 'wrong_slot', field: null, value: moves, slots: { from, to },
          fix: pending ? null : { action: 'arrange_slots', value: JSON.stringify(to) },
          note: pending
            ? `In the wrong slots: ${moves}. Fix this item's other supplier part-number problems first, then this.`
            : 'Moves each number to its supplier\'s slot (1 Mouser, 2 DigiKey, 3 LCSC); anything else keeps its place or goes to slot 4-5. Nothing is removed.' });
      }
    }

    const { partNumber } = pickPartNumbers(PART_NUMBER_FIELDS.map((f) => r[f]));
    if (!partNumber) {
      issues.push({ ...base, kind: 'no_part_number', field: null, value: null, fix: null,
        note: 'No part number to price it by. Add the manufacturer or a supplier part number if it is bought in; items made in-house need none.' });
    } else if (r.last_status === 'flagged' && r.flagged_part_number === partNumber) {
      const match = r.flagged_match ? ` (it matched ${r.flagged_match})` : '';
      issues.push({ ...base, kind: 'held_back', field: null, value: partNumber, fix: null,
        note: `Bulk pricing held its price back: the suppliers' answer for ${partNumber} was ${r.flagged_usd} USD each from ${r.flagged_provider}${match}, far above what this item costs. Correct the part number.` });
    }

    const name = String(r.name ?? '').trim();
    if (!STOCK_CODE.test(r.serial_number) && STOCK_CODE.test(name)) {
      issues.push({ ...base, kind: 'swapped', field: null, value: r.serial_number, fix: null,
        note: `The stock code is "${r.serial_number}" and the name is "${name}": they look swapped. Renaming a stock code isn't possible in the app yet.` });
    }
  }
  return issues;
}

const REVIEW_COLUMNS = `i.serial_number, i.name, i.supplier, ${PART_NUMBER_FIELDS.map((f) => `i.${f}`).join(', ')}`;

export interface ReviewDeps {
  query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;
  connect: () => Promise<Pick<PoolClient, 'query' | 'release'>>;
}
const defaultDeps: ReviewDeps = { query: (t, p) => query(t, p), connect: () => pool.connect() };

interface RequestedFix { serialNumber: string; field: PartNumberField | null; action: FixAction; expected: string; value?: string }

function parseFixes(body: any): RequestedFix[] | string {
  const list = body?.fixes;
  if (!Array.isArray(list) || list.length === 0) return 'fixes must be a non-empty list.';
  if (list.length > 2000) return 'At most 2000 fixes at a time.';
  const out: RequestedFix[] = [];
  for (const f of list) {
    if (!f || typeof f.serialNumber !== 'string' || !f.serialNumber.trim()) return 'Each fix needs a serialNumber.';
    if (!['move_to_supplier', 'clear', 'set', 'arrange_slots', 'move_to_slot', 'supplier_from_number'].includes(f.action)) return `Unknown action: ${f.action}.`;
    const fieldless = f.action === 'arrange_slots' || f.action === 'supplier_from_number';
    if (!fieldless && !(PART_NUMBER_FIELDS as readonly string[]).includes(f.field)) return `Unknown field: ${f.field}.`;
    if (f.action === 'move_to_slot' && !(SUP_FIELDS as readonly string[]).includes(f.value)) return `Unknown slot: ${f.value}.`;
    if (typeof f.expected !== 'string' || !f.expected.trim()) return 'Each fix needs the value it expects to change (expected).';
    if (['set', 'arrange_slots', 'move_to_slot', 'supplier_from_number'].includes(f.action) && typeof f.value !== 'string') return `A ${f.action} fix needs a value.`;
    out.push({
      serialNumber: f.serialNumber.trim(), field: fieldless ? null : f.field, action: f.action, expected: f.expected.trim(),
      value: f.action === 'set' ? f.value.trim() : ['arrange_slots', 'move_to_slot', 'supplier_from_number'].includes(f.action) ? f.value : undefined,
    });
  }
  return out;
}

export function registerPartNumberReviewRoutes(app: Express, deps: ReviewDeps = defaultDeps): void {
  app.get('/api/inventory/part-number-review', async (req: any, res) => {
    try {
      const { rows } = await deps.query(
        `SELECT ${REVIEW_COLUMNS}, s.last_status,
                h.part_number AS flagged_part_number, h.new_price_usd AS flagged_usd, h.provider AS flagged_provider, h.matched_part AS flagged_match
           FROM inventory i
           LEFT JOIN bulk_price_status s ON s.serial_number = i.serial_number
           LEFT JOIN LATERAL (
             SELECT x.part_number, x.new_price_usd, x.provider, x.matched_part FROM bulk_price_history x
              WHERE x.serial_number = i.serial_number AND x.status = 'flagged' AND x.dry_run = FALSE
              ORDER BY x.created_at DESC LIMIT 1
           ) h ON s.last_status = 'flagged'
          WHERE i.deleted IS NOT TRUE
          ORDER BY i.serial_number`
      );
      const issues = reviewItems(rows);
      const counts: Record<string, number> = {};
      for (const i of issues) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
      res.json({
        issues,
        counts,
        fixable: issues.filter((i) => i.fix).length,
        canFix: roleCan(req.user?.role, 'inventory.update'),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/inventory/part-number-review/fix', requirePermission('inventory.update'), async (req: any, res) => {
    const fixes = parseFixes(req.body);
    if (typeof fixes === 'string') return res.status(400).json({ error: fixes });
    const who = req.user?.email || 'unknown';
    const serials = [...new Set(fixes.map((f) => f.serialNumber))];

    let client: Pick<PoolClient, 'query' | 'release'> | null = null;
    try {
      client = await deps.connect();
      await client.query('BEGIN');
      // Lock the items, then work the review out again from what they hold now.
      const { rows } = await client.query(
        `SELECT ${REVIEW_COLUMNS} FROM inventory i WHERE i.serial_number = ANY($1::text[]) AND i.deleted IS NOT TRUE ORDER BY i.serial_number FOR UPDATE`,
        [serials]
      );
      const offered = new Map<string, PartNumberIssue>();
      const keyOf = (serial: string, field: string | null, action: FixAction) =>
        `${serial}|${action === 'arrange_slots' ? 'slots' : action === 'supplier_from_number' ? 'supplier' : field}`;
      for (const issue of reviewItems(rows)) {
        if (issue.fix && (issue.field || issue.fix.action === 'arrange_slots' || issue.fix.action === 'supplier_from_number')) {
          offered.set(keyOf(issue.serialNumber, issue.field, issue.fix.action), issue);
        }
      }

      const applied: Array<{ serialNumber: string; field: PartNumberField | null; action: FixAction; from: string; to: string | null; supplier?: string }> = [];
      const skipped: Array<{ serialNumber: string; field: string; reason: string }> = [];
      // In field order, so a supplier name moves before its copies are cleared.
      const order = (f: RequestedFix) => (f.field ? PART_NUMBER_FIELDS.indexOf(f.field) : PART_NUMBER_FIELDS.length);
      const ordered = [...fixes].sort((a, b) => a.serialNumber.localeCompare(b.serialNumber) || order(a) - order(b));
      for (const f of ordered) {
        const key = keyOf(f.serialNumber, f.field, f.action);
        const issue = offered.get(key);
        const matches = issue && issue.value === f.expected && issue.fix!.action === f.action
          && (!['set', 'arrange_slots', 'move_to_slot', 'supplier_from_number'].includes(f.action) || issue.fix!.value === f.value);
        if (!matches) {
          skipped.push({ serialNumber: f.serialNumber, field: f.field ?? 'sup_pn', reason: 'Changed since the list was loaded, or no longer needs this fix.' });
          continue;
        }
        offered.delete(key); // each fix once
        const logFix = (details: Record<string, unknown>) => client!.query(
          `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status)
           VALUES ($1, 'FIX_PART_NUMBER', 'Item', $2, $3, 'SUCCESS')`,
          [who, f.serialNumber, JSON.stringify(details)]
        );
        if (f.action === 'move_to_slot') {
          // value and field are from the fixed lists checked above.
          await client.query(`UPDATE inventory SET "${f.value}" = $2, "${f.field}" = 'N/A' WHERE serial_number = $1`, [f.serialNumber, f.expected]);
          await logFix({ field: f.field, action: f.action, from: f.expected, to: f.value });
          applied.push({ serialNumber: f.serialNumber, field: f.field, action: f.action, from: f.expected, to: f.value! });
          continue;
        }
        if (f.action === 'supplier_from_number') {
          const { supplier: name, slot } = JSON.parse(f.value!) as { supplier: string; slot: string | null };
          if (slot && !(SUP_FIELDS as readonly string[]).includes(slot)) throw new Error('bad slot');
          if (slot) await client.query(`UPDATE inventory SET supplier = $2, "${slot}" = $3 WHERE serial_number = $1`, [f.serialNumber, name, f.expected]);
          else await client.query(`UPDATE inventory SET supplier = $2 WHERE serial_number = $1`, [f.serialNumber, name]);
          await logFix({ field: 'supplier', action: f.action, from: f.expected, to: name, ...(slot ? { slot } : {}) });
          applied.push({ serialNumber: f.serialNumber, field: null, action: f.action, from: f.expected, to: name, supplier: name });
          continue;
        }
        if (f.action === 'arrange_slots') {
          // All five slots in one statement: nothing can be lost half way.
          const to: string[] = JSON.parse(f.value!);
          await client.query(
            `UPDATE inventory SET ${SUP_FIELDS.map((c, i) => `"${c}" = $${i + 2}`).join(', ')} WHERE serial_number = $1`,
            [f.serialNumber, ...to.map((v) => v || 'N/A')]
          );
          await client.query(
            `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status)
             VALUES ($1, 'FIX_PART_NUMBER', 'Item', $2, $3, 'SUCCESS')`,
            [who, f.serialNumber, JSON.stringify({ action: 'arrange_slots', moves: f.expected, from: issue!.slots?.from, to })]
          );
          applied.push({ serialNumber: f.serialNumber, field: null, action: f.action, from: f.expected, to: f.value! });
          continue;
        }
        const col = `"${f.field!}"`; // from the fixed list above
        let to: string | null = null;
        let supplier: string | undefined;
        if (f.action === 'move_to_supplier') {
          const { rows: [after] } = await client.query(
            `UPDATE inventory SET supplier = CASE WHEN COALESCE(TRIM(supplier), '') IN ('', 'N/A') THEN $2 ELSE supplier END, ${col} = NULL
              WHERE serial_number = $1 RETURNING supplier`,
            [f.serialNumber, f.expected]
          );
          supplier = after?.supplier ?? undefined;
        } else if (f.action === 'clear') {
          await client.query(`UPDATE inventory SET ${col} = NULL WHERE serial_number = $1`, [f.serialNumber]);
        } else {
          to = f.value!;
          await client.query(`UPDATE inventory SET ${col} = $2 WHERE serial_number = $1`, [f.serialNumber, to]);
        }
        await client.query(
          `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status)
           VALUES ($1, 'FIX_PART_NUMBER', 'Item', $2, $3, 'SUCCESS')`,
          [who, f.serialNumber, JSON.stringify({ field: f.field, action: f.action, from: f.expected, to, ...(supplier ? { supplier } : {}) })]
        );
        applied.push({ serialNumber: f.serialNumber, field: f.field, action: f.action, from: f.expected, to, ...(supplier ? { supplier } : {}) });
      }
      await client.query('COMMIT');
      res.json({ applied, skipped });
    } catch (err: any) {
      await client?.query('ROLLBACK').catch(() => {});
      res.status(500).json({ error: err.message });
    } finally {
      client?.release();
    }
  });
}
