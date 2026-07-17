// Imports LCSC pricing scraped by the Playwright bot script into the app's price cache.
// Usage: npm run lcsc:import -- [path/to/lcsc_products.csv]
// Defaults to ./lcsc_products.csv (the scraper's default output file, dropped in this repo).
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const csvPath = process.argv[2] || 'lcsc_products.csv';
const port = process.env.PORT || 3001;
const baseUrl = process.env.APP_URL || `http://localhost:${port}`;
const token = process.env.LCSC_IMPORT_TOKEN;

if (!token) {
  console.error('LCSC_IMPORT_TOKEN is not set in .env. Add it before importing.');
  process.exit(1);
}
if (!fs.existsSync(csvPath)) {
  console.error(`CSV not found: ${csvPath}`);
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0];
  const records = rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  return { headers, records };
}

const { records } = parseCsv(fs.readFileSync(csvPath, 'utf8'));

const items = [];
for (const r of records) {
  const partNumber = (r.lcsc_part || '').trim();
  if (!partNumber || partNumber === 'N/A') continue;

  const mpn = (r.mpn || '').trim();
  const priceNum = Number(r.unit_price_1);
  const stockMatch = (r.in_stock || '').match(/[\d,]+/);
  const stockNum = stockMatch ? Number(stockMatch[0].replace(/,/g, '')) : null;

  items.push({
    partNumber,
    mpn: mpn && mpn !== 'N/A' ? mpn : undefined,
    price: Number.isFinite(priceNum) ? priceNum : null,
    stock: Number.isFinite(stockNum) ? stockNum : null,
    currency: 'USD',
    url: r.url || undefined,
  });
}

if (!items.length) {
  console.log('No importable rows found in CSV (missing lcsc_part values).');
  process.exit(0);
}

const res = await fetch(`${baseUrl}/api/pricing/lcsc/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(items),
});

if (!res.ok) {
  console.error(`Import failed (${res.status}): ${await res.text()}`);
  process.exit(1);
}

const result = await res.json();
console.log(`✅ Imported ${result.imported} LCSC parts from ${csvPath}.`);
