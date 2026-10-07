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
  NONE_MARKERS, PART_NUMBER_FIELDS, PLACEHOLDER_PART_NUMBERS, looksLikeName, pickPartNumbers,
  type PartNumberField,
} from './partNumbers';

export type IssueKind = 'supplier_name' | 'placeholder' | 'lcsc_extra_text' | 'not_a_part_number' | 'held_back' | 'swapped' | 'no_part_number';
export type FixAction = 'move_to_supplier' | 'clear' | 'set';

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

interface RequestedFix { serialNumber: string; field: PartNumberField; action: FixAction; expected: string; value?: string }

function parseFixes(body: any): RequestedFix[] | string {
  const list = body?.fixes;
  if (!Array.isArray(list) || list.length === 0) return 'fixes must be a non-empty list.';
  if (list.length > 2000) return 'At most 2000 fixes at a time.';
  const out: RequestedFix[] = [];
  for (const f of list) {
    if (!f || typeof f.serialNumber !== 'string' || !f.serialNumber.trim()) return 'Each fix needs a serialNumber.';
    if (!(PART_NUMBER_FIELDS as readonly string[]).includes(f.field)) return `Unknown field: ${f.field}.`;
    if (!['move_to_supplier', 'clear', 'set'].includes(f.action)) return `Unknown action: ${f.action}.`;
    if (typeof f.expected !== 'string' || !f.expected.trim()) return 'Each fix needs the value it expects to change (expected).';
    if (f.action === 'set' && typeof f.value !== 'string') return 'A set fix needs a value.';
    out.push({ serialNumber: f.serialNumber.trim(), field: f.field, action: f.action, expected: f.expected.trim(), value: f.action === 'set' ? f.value.trim() : undefined });
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
      for (const issue of reviewItems(rows)) if (issue.fix && issue.field) offered.set(`${issue.serialNumber}|${issue.field}`, issue);

      const applied: Array<{ serialNumber: string; field: PartNumberField; action: FixAction; from: string; to: string | null; supplier?: string }> = [];
      const skipped: Array<{ serialNumber: string; field: string; reason: string }> = [];
      // In field order, so a supplier name moves before its copies are cleared.
      const ordered = [...fixes].sort((a, b) => a.serialNumber.localeCompare(b.serialNumber) || PART_NUMBER_FIELDS.indexOf(a.field) - PART_NUMBER_FIELDS.indexOf(b.field));
      for (const f of ordered) {
        const issue = offered.get(`${f.serialNumber}|${f.field}`);
        const matches = issue && issue.value === f.expected && issue.fix!.action === f.action && (f.action !== 'set' || issue.fix!.value === f.value);
        if (!matches) {
          skipped.push({ serialNumber: f.serialNumber, field: f.field, reason: 'Changed since the list was loaded, or no longer needs this fix.' });
          continue;
        }
        offered.delete(`${f.serialNumber}|${f.field}`); // each fix once
        const col = `"${f.field}"`; // from the fixed list above
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
