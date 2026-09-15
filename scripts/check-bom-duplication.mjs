// Read-only diagnostic. For every project referenced anywhere in the
// eligible db_bom tables, prints:
//   - which eligible tables carry rows for that project
//   - the total row count vs the count of distinct (stockCode, designator)
//   - the top duplicate (stockCode, designator) pairs when any exist
// so we can see whether BOM Manager is showing the same row twice
// because it lives in two tables, or something else.
import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
const env = fs.readFileSync('.env', 'utf8');
const dbUrl = env.match(/DATABASE_URL="([^"]+)"/)[1];
const sql = neon(dbUrl);

const ELIGIBLE_UNIVERSAL = ['db_bom', 'db_bom_ncu04', 'db_bom_loradongle'];

const tablesRes = await sql`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'db_bom%' ORDER BY 1`;
const eligible = tablesRes.map(r => r.t).filter(t => ELIGIBLE_UNIVERSAL.includes(t) || /^db_bom_project_\d+$/.test(t));
console.log('Eligible tables:', eligible.join(', '), '\n');

const projectRows = new Map(); // pid -> [{table, stockCode, qty, designator}]
for (const t of eligible) {
  const rows = await sql.query(`SELECT * FROM "${t}"`);
  for (const r of rows) {
    const pid = parseInt(String(r.project_name ?? '')) || 1;
    const stockCode = String(r.internal_stock_number || r.stock_code || '');
    const designator = String(r.ref_des || r.designator || '');
    const qty = parseInt(r.qty_per_unit || r.quantity || '1') || 1;
    if (!projectRows.has(pid)) projectRows.set(pid, []);
    projectRows.get(pid).push({ table: t, stockCode, designator, qty });
  }
}

const projects = await sql`SELECT id::text as id, project_name FROM projects ORDER BY id::int`;
const nameByPid = new Map(projects.map(p => [parseInt(p.id), p.project_name]));

let anyDupe = false;
for (const [pid, rows] of [...projectRows.entries()].sort((a, b) => a[0] - b[0])) {
  const byTable = rows.reduce((m, r) => { m[r.table] = (m[r.table] || 0) + 1; return m; }, {});
  const key = r => `${r.stockCode}||${r.designator}`;
  const groups = rows.reduce((m, r) => { const k = key(r); (m[k] = m[k] || []).push(r); return m; }, {});
  const dupes = Object.entries(groups).filter(([, arr]) => arr.length > 1);
  const distinct = Object.keys(groups).length;

  const flag = dupes.length > 0 ? ' ⚠️  DUPLICATES' : '';
  const pname = nameByPid.get(pid) || '(no project row)';
  console.log(`Project ${pid} — ${pname}${flag}`);
  console.log(`  tables:`, byTable);
  console.log(`  total rows: ${rows.length},  distinct (stockCode, designator): ${distinct}`);
  if (dupes.length > 0) {
    anyDupe = true;
    console.log(`  duplicate groups (top 5):`);
    for (const [k, arr] of dupes.slice(0, 5)) {
      const [sc, des] = k.split('||');
      console.log(`    ${sc}${des ? ' [' + des + ']' : ''}  ×${arr.length}  from: ${arr.map(a => a.table).join(', ')}`);
    }
    if (dupes.length > 5) console.log(`    …and ${dupes.length - 5} more duplicate groups`);
  }
  console.log('');
}

if (!anyDupe) console.log('No (stockCode, designator) duplicates across the eligible table set.');

// Second pass: same stockCode appearing in multiple tables for one project.
// That's how the same part can appear twice in BOM Manager (once from the
// universal table, once from the per-project table) even when the raw
// (stockCode, designator) pairs are distinct — designator differs but the
// component is the same. This is what "BOM has duplicated itself" often means.
console.log('\n=== Same stockCode in multiple tables per project ===');
let anyMultiTable = false;
for (const [pid, rows] of [...projectRows.entries()].sort((a, b) => a[0] - b[0])) {
  const byStockCode = new Map();
  for (const r of rows) {
    if (!r.stockCode) continue;
    if (!byStockCode.has(r.stockCode)) byStockCode.set(r.stockCode, new Set());
    byStockCode.get(r.stockCode).add(r.table);
  }
  const multi = [...byStockCode.entries()].filter(([, tables]) => tables.size > 1);
  if (multi.length === 0) continue;
  anyMultiTable = true;
  const pname = nameByPid.get(pid) || '(no project row)';
  console.log(`Project ${pid} — ${pname}`);
  for (const [sc, tables] of multi.slice(0, 8)) {
    console.log(`  ${sc}  →  ${[...tables].join(' + ')}`);
  }
  if (multi.length > 8) console.log(`  …and ${multi.length - 8} more stock codes with multi-table presence`);
  console.log('');
}
if (!anyMultiTable) console.log('No stock code appears in two eligible tables for the same project.');

