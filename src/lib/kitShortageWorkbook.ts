// Kit Booking > Save presets: every selected build quantity, and every
// ticked supplier for each, as sheets of one workbook (instead of a CSV
// each). Sheets, in order: Summary, then for each quantity "Qty 50" (the
// shortages list) followed by "Qty 50 LCSC" / "Qty 50 Mouser" /
// "Qty 50 DigiKey" (what to order from that supplier, in its upload
// columns, then the lines it has no part number for). Numbers are cells
// of numbers, so the sheets sort and sum. Same maths as the CSV export.

export type KitSupplier = 'lcsc' | 'mouser' | 'digikey';
export const KIT_SUPPLIER_LABEL: Record<KitSupplier, string> = { lcsc: 'LCSC', mouser: 'Mouser', digikey: 'DigiKey' };

export interface KitRow {
  component_id: string;
  resolved_part_number: string;
  used_alternative: boolean;
  qty_required: number;
  qty_on_hand: number;
  description: string;
  designator?: string;
}

export interface Sheet { name: string; rows: Array<Array<string | number>>; widths: number[] }

export interface WorkbookInput<R extends KitRow> {
  rows: R[];
  buildQty: number;              // the quantity the audit ran at (qty per PCB is backed out of it)
  quantities: number[];
  suppliers: KitSupplier[];
  includeDnf: boolean;
  isDnf: (r: R) => boolean;
  reservedElsewhere: (r: R) => number;
  supplierPn: (r: R, s: KitSupplier) => string;
  projectName: string;
  date: string;
}

const perPcb = (r: KitRow, buildQty: number) => (buildQty > 0 ? Math.max(1, Math.round(r.qty_required / buildQty)) : r.qty_required);

/** The sheets for the selection; a quantity with no shortages still gets its sheet, saying so. */
export function buildShortageSheets<R extends KitRow>(input: WorkbookInput<R>): Sheet[] {
  const { rows, buildQty, quantities, suppliers, includeDnf, isDnf } = input;
  const summary: Sheet = {
    name: 'Summary',
    rows: [
      [`${input.projectName}: shortages by build quantity`], [`Made ${input.date}${includeDnf ? ', DNF parts included' : ''}`], [],
      ['Build qty', 'Shortage lines', 'Units short', ...suppliers.flatMap((s) => [`${KIT_SUPPLIER_LABEL[s]} lines`, `No ${KIT_SUPPLIER_LABEL[s]} PN`])],
    ],
    widths: [12, 15, 12, ...suppliers.flatMap(() => [14, 16])],
  };
  const sheets: Sheet[] = [summary];

  for (const atQty of quantities) {
    const lines = rows.map((r) => {
      const qtyPerPcb = perPcb(r, buildQty);
      const needed = qtyPerPcb * atQty;
      const dnf = isDnf(r);
      return { r, qtyPerPcb, needed, dnf, shortage: dnf ? 0 : Math.max(0, needed - r.qty_on_hand) };
    }).filter((l) => (l.dnf ? includeDnf : l.shortage > 0));

    const base: Sheet = {
      name: `Qty ${atQty}`,
      rows: [['Part', 'Description', 'Designator', 'Qty per PCB', 'Needed', 'On Hand', 'Shortage', 'Alternates used', 'Reserved elsewhere']],
      widths: [16, 40, 18, 11, 10, 10, 10, 16, 16],
    };
    for (const l of lines) {
      base.rows.push([l.r.component_id, l.r.description || '', l.r.designator || '', l.qtyPerPcb, l.needed, l.r.qty_on_hand,
        l.dnf ? 'DNF' : l.shortage, l.r.used_alternative ? l.r.resolved_part_number : '', input.reservedElsewhere(l.r)]);
    }
    if (!lines.length) base.rows.push(['No shortages at this build quantity.']);
    sheets.push(base);

    const summaryRow: Array<string | number> = [atQty, lines.filter((l) => !l.dnf).length, lines.reduce((s, l) => s + l.shortage, 0)];

    for (const s of suppliers) {
      const label = KIT_SUPPLIER_LABEL[s];
      const orderable = lines.filter((l) => !l.dnf && l.shortage > 0).map((l) => ({ ...l, pn: input.supplierPn(l.r, s) }));
      const withPn = orderable.filter((o) => o.pn);
      const without = orderable.filter((o) => !o.pn);
      const sheet: Sheet = { name: `Qty ${atQty} ${label}`, rows: [], widths: [] };
      // Each supplier's upload columns (the same as their CSV files).
      if (s === 'mouser') {
        sheet.rows.push(['Mouser Part Number', 'Quantity', 'Paste line (PN|qty)']);
        for (const o of withPn) sheet.rows.push([o.pn, o.shortage, `${o.pn}|${o.shortage}`]);
        sheet.widths = [24, 10, 30];
      } else if (s === 'digikey') {
        sheet.rows.push(['Quantity', 'Part Number']);
        for (const o of withPn) sheet.rows.push([o.shortage, o.pn]);
        sheet.widths = [10, 26];
      } else {
        sheet.rows.push(['Comment', 'Designator', 'Footprint', 'LCSC Part #', 'Quantity']);
        for (const o of withPn) sheet.rows.push([(o.r.description || '').replace(/,/g, ' '), '', '', o.pn, o.shortage]);
        sheet.widths = [40, 12, 12, 14, 10];
      }
      if (!withPn.length) sheet.rows.push([`Nothing to order from ${label} at this quantity.`]);
      if (without.length) {
        sheet.rows.push([], [`Not orderable from ${label}: no ${label} part number (${without.length})`], ['Part', 'Needed', 'On Hand', 'Shortage']);
        for (const o of without) sheet.rows.push([o.r.component_id, o.needed, o.r.qty_on_hand, o.shortage]);
      }
      sheets.push(sheet);
      summaryRow.push(withPn.length, without.length);
    }
    summary.rows.push(summaryRow);
  }
  return sheets;
}

/** Excel's sheet-name rules: 31 characters, none of : \ / ? * [ ], unique. */
export function safeSheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    const base = n.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31).trim() || 'Sheet';
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} ${i}`;
    used.add(name.toLowerCase());
    return name;
  });
}
