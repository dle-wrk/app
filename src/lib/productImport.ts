// Bulk import for Production Costs (the finished-product catalogue): reads a
// spreadsheet or CSV and works out what it would add and change. The page
// (ProductionCostsView) reads the file and shows the preview; the server
// (POST /api/production-products/import in productionRoutes) works the plan
// out again against the database and applies it.
//
// - Columns are found by their header names, in any order; the header row
//   is the first row with a model-number column, and in a workbook the first
//   sheet that has one is used.
// - A product is matched to the catalogue by model number (ignoring case and
//   spaces at the ends). A new model number adds a product.
// - Only cells with something in them are written: an empty cell keeps what
//   is on file, so a sheet of prices alone changes only prices.
// - Amounts may be written the South African way ("R 8 827,89") or with a
//   comma thousands separator ("8,827.89").

export interface ProductFields {
  description?: string;
  category?: string;
  productionCost?: number;
  sellingPrice?: number;
  notes?: string;
}

export interface ProductImportRow extends ProductFields {
  /** The row number in the file, for messages. */
  line: number;
  modelNumber: string;
}

export interface ProductTable {
  sheetName: string | null;
  /** The product fields the file has. */
  columns: Array<keyof ProductFields>;
  /** Header cells that matched nothing, so nothing is dropped silently. */
  ignoredHeaders: string[];
  rows: ProductImportRow[];
  /** Plain-language notes about rows or cells that were left out. */
  notes: string[];
}

export const FIELD_LABELS: Record<keyof ProductFields, string> = {
  description: 'Description',
  category: 'Category',
  productionCost: 'Production cost',
  sellingPrice: 'Selling price',
  notes: 'Notes',
};

const norm = (h: unknown) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const MODEL_HEADERS = ['model', 'model number', 'model no', 'model nr', 'model code', 'product code', 'sku', 'part number', 'code'];
const HEADERS: Record<keyof ProductFields, string[]> = {
  description: ['description', 'desc', 'product', 'product name', 'name'],
  category: ['category', 'type', 'product category', 'group'],
  productionCost: ['prod cost', 'production cost', 'build cost', 'cost', 'cost price', 'total cost', 'cogs', 'unit cost'],
  sellingPrice: ['selling price', 'sell price', 'price', 'sale price', 'list price', 'retail price', 'selling price excl vat', 'price excl vat'],
  notes: ['notes', 'note', 'comments', 'comment', 'remarks'],
};
// "Model #" normalises to "model"; "Prod. cost (ZAR)" to "prod cost zar".
const strip = (h: string) => h.replace(/\b(zar|r|excl|incl|vat|ex)\b/g, ' ').replace(/\s+/g, ' ').trim();

function fieldFor(header: unknown): keyof ProductFields | 'modelNumber' | null {
  const h = norm(header);
  if (!h) return null;
  const candidates = [h, strip(h)];
  if (candidates.some((c) => MODEL_HEADERS.includes(c))) return 'modelNumber';
  for (const [field, names] of Object.entries(HEADERS) as Array<[keyof ProductFields, string[]]>) {
    if (candidates.some((c) => names.includes(c))) return field;
  }
  return null;
}

/** An amount from a cell: a number, or text like "R 8 827,89", "8,827.89" or "1234.5". null when it isn't one. */
export function parseAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value ?? '').trim();
  if (!s) return null;
  s = s.replace(/^(zar|r)\s*/i, '').replace(/[\s  ']/g, '');
  if (!/^-?[\d.,]+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Both: whichever comes last is the decimal mark.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // Only commas: thousands when they group threes ("8,827"), else the decimal mark ("8827,89").
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }
  if ((s.match(/\./g) ?? []).length > 1) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

const text = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '')).trim();

export function readProductTable(table: unknown[][], sheetName: string | null = null): ProductTable | { error: string } {
  const headerIndex = table.findIndex((row) => Array.isArray(row) && row.some((cell) => fieldFor(cell) === 'modelNumber'));
  if (headerIndex < 0) return { error: 'it has no model number column (a header such as "Model #" or "Model number").' };
  const header = table[headerIndex];
  const columns = new Map<number, keyof ProductFields | 'modelNumber'>();
  const ignoredHeaders: string[] = [];
  const used = new Set<string>();
  header.forEach((cell, i) => {
    const field = fieldFor(cell);
    if (field && !used.has(field)) { columns.set(i, field); used.add(field); } else if (text(cell)) ignoredHeaders.push(text(cell));
  });

  const rows: ProductImportRow[] = [];
  const notes: string[] = [];
  const seen = new Map<string, number>();
  for (let r = headerIndex + 1; r < table.length; r++) {
    const cells = table[r] ?? [];
    const line = r + 1;
    const row: Partial<ProductImportRow> = { line };
    for (const [i, field] of columns) {
      const raw = cells[i];
      if (field === 'productionCost' || field === 'sellingPrice') {
        if (text(raw) === '') continue;
        const amount = parseAmount(raw);
        if (amount === null || amount < 0) notes.push(`Row ${line}: ${FIELD_LABELS[field].toLowerCase()} "${text(raw)}" isn't an amount, so it was left out.`);
        else row[field] = amount;
      } else {
        const value = text(raw);
        if (value) (row as any)[field] = value;
      }
    }
    if (!row.modelNumber) {
      if (Object.keys(row).length > 1) notes.push(`Row ${line} has no model number, so it was left out.`);
      continue;
    }
    const key = row.modelNumber.toLowerCase();
    if (seen.has(key)) {
      notes.push(`Row ${line}: ${row.modelNumber} is also on row ${seen.get(key)}; only the first was used.`);
      continue;
    }
    seen.set(key, line);
    rows.push(row as ProductImportRow);
  }
  return {
    sheetName,
    columns: [...columns.values()].filter((f): f is keyof ProductFields => f !== 'modelNumber'),
    ignoredHeaders,
    rows,
    notes,
  };
}

/** The first sheet of a workbook that has a model number column. */
export function readProductSheets(sheets: Array<{ name: string; rows: unknown[][] }>): ProductTable | { error: string } {
  for (const sheet of sheets) {
    const table = readProductTable(sheet.rows, sheet.name);
    if (!('error' in table)) return table;
  }
  return { error: 'none of its sheets has a model number column (a header such as "Model #" or "Model number").' };
}

export interface ExistingProduct extends Omit<ProductFields, 'productionCost' | 'sellingPrice'> {
  id: number;
  modelNumber: string;
  productionCost?: number | null;
  sellingPrice?: number | null;
}

export interface ProductChange {
  line: number;
  modelNumber: string;
  kind: 'new' | 'changed' | 'unchanged';
  /** The catalogue product, for changes. */
  id: number | null;
  /** What gets written. */
  set: ProductFields;
  /** The values on file before, for the fields that change. */
  before: Partial<Record<keyof ProductFields, string | number | null>>;
}

const FIELDS: Array<keyof ProductFields> = ['description', 'category', 'productionCost', 'sellingPrice', 'notes'];
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null)
  || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.005);

/** What importing these rows would do to the catalogue. */
export function planProductImport(rows: ProductImportRow[], existing: ExistingProduct[]): ProductChange[] {
  const byModel = new Map(existing.map((p) => [p.modelNumber.trim().toLowerCase(), p]));
  return rows.map((row) => {
    const current = byModel.get(row.modelNumber.trim().toLowerCase());
    const set: ProductFields = {};
    const before: ProductChange['before'] = {};
    for (const f of FIELDS) {
      if (row[f] === undefined) continue;
      if (current && same(current[f], row[f])) continue;
      (set as any)[f] = row[f];
      if (current) before[f] = (current[f] ?? null) as any;
    }
    const kind = !current ? 'new' : Object.keys(set).length ? 'changed' : 'unchanged';
    return { line: row.line, modelNumber: current?.modelNumber ?? row.modelNumber.trim(), kind, id: current?.id ?? null, set, before };
  });
}

/** The catalogue as a CSV in the import's own columns, to edit and import back. */
export function productsToCsv(products: Array<ExistingProduct>): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['Model #', 'Description', 'Category', 'Production cost', 'Selling price', 'Notes'].join(',')];
  for (const p of products) {
    lines.push([p.modelNumber, p.description, p.category, p.productionCost, p.sellingPrice, p.notes].map(cell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
